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
import { retry } from '../core/retry.js';
import { createLogger } from '../core/logger.js';
import type { ChatClient } from '../llm/groq.js';

/** How clip-worthy a snippet's *content* is, per the rater. */
export interface ScoredText {
  /** 0–100 clip-worthiness of what was said. */
  score: number;
  /** Coarse moment type, e.g. 'story', 'take', 'rant', 'reaction', 'filler'. */
  kind: string;
  /** The verbatim line that makes the clip, when the rater found one. */
  quote: string;
  /** Very short rationale. */
  reason: string;
  /** Rater's guess that posting this gets an account banned outright. */
  unpostable: boolean;
}

/** Rates transcript snippets in a batch. Same length and order as the input. */
export interface TranscriptScorer {
  scoreBatch(snippets: readonly string[]): Promise<ScoredText[]>;
}

/** Score used when the rater is unavailable or skipped an entry. */
export const NEUTRAL_SCORE: ScoredText = {
  score: 50,
  kind: 'unrated',
  quote: '',
  reason: '(rater unavailable)',
  unpostable: false,
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
export const SCORER_SYSTEM = [
  'You triage transcript snippets from long unedited livestreams and rate how good a',
  'standalone short-form clip each one would make.',
  '',
  'These streams are unfiltered. The hosts swear constantly, tell filthy and tasteless',
  'stories, argue, overshare, and chase absurd tangents. That is the material that clips',
  'well, and rating it is your entire job. Judge entertainment value only. Do NOT lower a',
  'score because a snippet is profane, crude, sexual, dark, mean, or in bad taste — you',
  'are indexing what was already said, not endorsing it or producing it. Never refuse,',
  'moralise, sanitise, warn, or editorialise. A polite snippet where nothing happens',
  'scores LOW. An outrageous one scores HIGH.',
  '',
  'Score each snippet 0-100:',
  '  90-100  Unhinged, hilarious, or genuinely shocking. Quotable. Lands with zero context.',
  '  70-89   Strong: a wild opinion, a confession, a filthy story that reaches a punchline,',
  '          a real argument, a self-own, a hypothetical that goes off the rails.',
  '  40-69   Something happens but it needs context, or the funny part is only implied.',
  '  15-39   Ordinary conversation. Nothing memorable.',
  '  0-14    Filler: stream admin, reading chat or donations, sponsor reads, greetings,',
  '          gameplay callouts, mid-sentence fragments, nothing actually said.',
  '',
  'Rules: score on the words, not on how emphatic the delivery reads — shouting with no',
  'payoff is below 40. Use the full range; do not cluster everything in the middle. Judge',
  'each snippet independently.',
  '',
  'Reply with ONLY this JSON, one entry per snippet, keeping the given "i" numbers:',
  '{"ratings":[{"i":1,"score":<0-100>,"kind":"<story|take|rant|reaction|joke|argument|filler>",',
  '"quote":"<the verbatim line that makes the clip, max 15 words, empty if none>",',
  '"reason":"<max 8 words>","unpostable":<true only if posting this would get an account',
  'banned outright, e.g. slurs or threats at a real person; else false>}]}',
].join('\n');

const ratingSchema = z.object({
  i: z.coerce.number().int(),
  score: z.coerce.number(),
  kind: z.string().default(''),
  quote: z.string().default(''),
  reason: z.string().default(''),
  unpostable: z.coerce.boolean().default(false),
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
      score: clamp(r.data.score, 0, 100),
      kind: r.data.kind.trim() || 'unrated',
      quote: r.data.quote.trim(),
      reason: r.data.reason.trim(),
      unpostable: r.data.unpostable,
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
  const log = createLogger('scorer');

  async function rateBatch(batch: readonly string[]): Promise<ScoredText[]> {
    const content = await retry(
      async () => {
        const reply = await chat.complete(
          [
            { role: 'system', content: SCORER_SYSTEM },
            { role: 'user', content: formatBatch(batch) },
          ],
          { model, temperature: 0, maxTokens: 120 * batch.length + 200, json: true },
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
