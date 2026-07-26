/**
 * Transcript content rater: the signal that actually picks clips.
 *
 * Two things make this affordable enough to run over a whole VOD instead of over a
 * loudness shortlist:
 *   - **Batching.** N snippets go out per request, so rating hundreds of windows costs
 *     tens of calls, not hundreds.
 *   - **A tight output shape.** Score, kind, punchline, eight-word reason. Nothing else.
 *
 * The rubric is anchored with score bands because an unanchored "rate 0-10" prompt at
 * temperature 0 returns 6 or 7 for almost everything — and a flat text signal hands the
 * ranking straight back to loudness, which is the bug this module exists to fix.
 */
import { z } from 'zod';
import type { PromptStore } from '../core/contracts.js';
import { retry } from '../core/retry.js';
import { createLogger } from '../core/logger.js';
import type { ChatClient } from '../llm/groq.js';
import { CLIP_SKILL_MD, SKILL_NAME } from './skill.js';

/** How clip-worthy a snippet's *content* is, per the rater, on the skill's three axes. */
export interface ScoredText {
  /** Is it actually funny? 0–100. */
  funny: number;
  /** Do the first seconds stop a scroll? 0–100. */
  hook: number;
  /** How out of pocket is it? 0–100. */
  pocket: number;
  /** The verbatim line that *should* open the clip, when the rater found a better one. */
  hookQuote: string;
  /** The verbatim line the clip pays off on. */
  punchQuote: string;
  /** Coarse moment type, e.g. 'story', 'take', 'rant', 'reaction', 'filler'. */
  kind: string;
  /** Very short rationale. */
  reason: string;
  /** Informational only: posting this as-is might get a channel actioned. */
  risky: boolean;
}

/** Rates transcript snippets in a batch. Same length and order as the input. */
export interface TranscriptScorer {
  scoreBatch(snippets: readonly string[]): Promise<ScoredText[]>;
}

/**
 * Score used when the rater is unavailable or skipped an entry. Deliberately mid on every
 * axis: it must not clear the floors on merit, but it must not look like a considered
 * rejection either.
 */
export const NEUTRAL_SCORE: ScoredText = {
  funny: 50,
  hook: 50,
  pocket: 50,
  hookQuote: '',
  punchQuote: '',
  kind: 'unrated',
  reason: '(rater unavailable)',
  risky: false,
};

/**
 * The rating rubric.
 *
 * The explicit "don't dock points for crude content" clause is load-bearing, not
 * decoration. Asked a bare "would this make a good clip?", an assistant-tuned model
 * hedges on exactly the material these streams are built out of — it rates the filthy
 * story mid and the polite chat greeting mid, and the whole signal collapses. The model
 * here is a librarian: it reads what was already said and files it. Saying so plainly is
 * what gets a usable spread of scores back.
 */
export type SkillLoader = () => Promise<string>;

/**
 * Default skill loader: the prompt store, falling back to the bundled skill.
 *
 * Going through the store is the whole point — the on-disk markdown at
 * `<dataDir>/prompts/clip-skill.v1.md` is the source of truth, so the criteria can be
 * retuned between runs without a rebuild.
 */
export function promptStoreSkillLoader(store: PromptStore): SkillLoader {
  const log = createLogger('scorer');
  return async () => {
    try {
      return (await store.get(SKILL_NAME)).template;
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'clip skill missing from prompt store; using bundled default',
      );
      return CLIP_SKILL_MD;
    }
  };
}

const ratingSchema = z.object({
  i: z.coerce.number().int(),
  funny: z.coerce.number(),
  hook: z.coerce.number(),
  pocket: z.coerce.number(),
  hook_quote: z.string().default(''),
  punch_quote: z.string().default(''),
  kind: z.string().default(''),
  reason: z.string().default(''),
  risky: z.coerce.boolean().default(false),
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Pull the ratings array out of a reply, tolerating whatever key the model chose. */
function extractArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) return value;
    }
  }
  throw new Error('rating reply contained no array');
}

/**
 * Parse a batch reply into exactly `count` scores, positioned by the `i` field.
 * Entries the model dropped or numbered out of range fall back to {@link NEUTRAL_SCORE},
 * so one malformed row never discards a whole batch.
 */
export function parseBatchScores(raw: string, count: number): ScoredText[] {
  const out: ScoredText[] = Array.from({ length: count }, () => ({ ...NEUTRAL_SCORE }));
  for (const entry of extractArray(JSON.parse(raw))) {
    const r = ratingSchema.safeParse(entry);
    if (!r.success) continue;
    const idx = r.data.i - 1;
    if (idx < 0 || idx >= count) continue;
    out[idx] = {
      funny: clamp(r.data.funny, 0, 100),
      hook: clamp(r.data.hook, 0, 100),
      pocket: clamp(r.data.pocket, 0, 100),
      hookQuote: r.data.hook_quote.trim(),
      punchQuote: r.data.punch_quote.trim(),
      kind: r.data.kind.trim() || 'unrated',
      reason: r.data.reason.trim(),
      risky: r.data.risky,
    };
  }
  return out;
}

/** Render numbered snippets for one request. */
export function formatBatch(snippets: readonly string[], maxCharsPerSnippet = 900): string {
  return snippets
    .map((s, i) => `[${i + 1}] ${s.replace(/\s+/g, ' ').trim().slice(0, maxCharsPerSnippet)}`)
    .join('\n\n');
}

export interface ChatScorerOptions {
  chat: ChatClient;
  model: string;
  /** Snippets per request. */
  batchSize?: number;
  /** Retries per batch on transient API errors. */
  retries?: number;
  /** Where the skill comes from; defaults to the bundled skill. */
  skill?: SkillLoader;
}

/**
 * Build a {@link TranscriptScorer} over a chat client. Batches fail soft: a batch that
 * cannot be rated after retries yields neutral scores for its snippets and detection
 * carries on, rather than losing the whole source to one bad response.
 */
export function createChatScorer(opts: ChatScorerOptions): TranscriptScorer {
  const { chat, model } = opts;
  const batchSize = opts.batchSize ?? 12;
  const retries = opts.retries ?? 3;
  const loadSkill = opts.skill ?? (async () => CLIP_SKILL_MD);
  const log = createLogger('scorer');
  // Resolved once per scorer: a source is rated across many batches and re-reading the
  // skill per batch would let the criteria change halfway through a source.
  let skillPromise: Promise<string> | undefined;

  async function rateBatch(batch: readonly string[]): Promise<ScoredText[]> {
    skillPromise ??= loadSkill();
    const skill = await skillPromise;
    const content = await retry(
      async () => {
        const reply = await chat.complete(
          [
            { role: 'system', content: skill },
            { role: 'user', content: formatBatch(batch) },
          ],
          { model, temperature: 0, maxTokens: 160 * batch.length + 200, json: true },
        );
        // Parse inside the retry: a truncated or malformed reply is worth another attempt.
        return parseBatchScores(reply, batch.length);
      },
      {
        retries,
        onRetry: (err, attempt) =>
          log.warn({ attempt, err: (err as Error).message }, 'rating batch failed; retrying'),
      },
    );
    return content;
  }

  return {
    async scoreBatch(snippets) {
      const results: ScoredText[] = [];
      for (let i = 0; i < snippets.length; i += batchSize) {
        const batch = snippets.slice(i, i + batchSize);
        try {
          results.push(...(await rateBatch(batch)));
        } catch (err) {
          log.warn(
            { from: i, size: batch.length, err: (err as Error).message },
            'rating batch gave up; using neutral scores',
          );
          results.push(...batch.map(() => ({ ...NEUTRAL_SCORE })));
        }
      }
      return results;
    },
  };
}
