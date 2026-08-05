/**
 * Caption writer: turns a clip candidate into an on-screen title plus platform post
 * descriptions. On failure it falls back to deterministic title/description text so the
 * pipeline never stalls on the LLM.
 */
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import type { CaptionWriter } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import type { Caption, ClipCandidate } from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';

const captionSchema = z.object({
  caption: z.string(),
  tiktok: z.string().optional(),
  instagram: z.string().optional(),
});

interface CaptionPayload {
  caption: string;
  tiktok?: string;
  instagram?: string;
}

type PlatformDescriptions = NonNullable<Caption['descriptions']>;

/** Parse the tiny-LLM JSON caption reply. Throws on unparseable input. */
export function parseCaption(raw: string): string {
  return parseCaptionPayload(raw).caption;
}

export function parseCaptionPayload(raw: string): CaptionPayload {
  const parsed = captionSchema.parse(JSON.parse(raw));
  return {
    caption: parsed.caption.trim(),
    tiktok: normalizeDescription(parsed.tiktok),
    instagram: normalizeDescription(parsed.instagram),
  };
}

/**
 * Deterministic caption used when the LLM is unavailable.
 *
 * Falls back to the *opening* words rather than the punchline quote: the caption is a title
 * that sets the clip up, so echoing the payoff is worse than a plain premise.
 */
export function fallbackCaption(candidate: ClipCandidate): string {
  const words = candidate.transcriptText.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length > 0) return words.join(' ');
  return candidate.reason || 'You have to see this';
}

function cleanHashtagTerm(value: string): string {
  return value
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`,
    )
    .join('');
}

function uniqueHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const cleaned = cleanHashtagTerm(raw);
    if (!cleaned) continue;
    const tag = `#${cleaned}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function candidateHashtags(candidate: ClipCandidate): string[] {
  const base = [
    'fyp',
    'viral',
    'streamer',
    'livestream',
    candidate.kind ?? '',
    candidate.renderLayout === 'stack' ? 'omegle' : '',
  ];
  const topicWords =
    `${candidate.reason} ${candidate.transcriptText}`.toLowerCase().match(/\b[a-z0-9]{5,}\b/g) ??
    [];
  return uniqueHashtags([...base, ...topicWords.slice(0, 10)]).slice(0, 8);
}

export function normalizeDescription(value: string | undefined): string | undefined {
  const text = value
    ?.trim()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return text && text.length > 0 ? text : undefined;
}

export function normalizeCreatorHandle(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const first = raw.split(/[\s,]+/)[0] ?? '';
  const handle = first.replace(/^@+/, '').replace(/[^a-zA-Z0-9._]/g, '');
  return handle.length > 0 ? `@${handle}` : undefined;
}

export function withCreatorAttribution(
  description: string,
  creatorHandle: string | undefined,
): string {
  const handle = normalizeCreatorHandle(creatorHandle);
  if (!handle) return description;
  if (description.toLowerCase().includes(handle.toLowerCase())) return description;

  const blocks = description.split(/\n\n/);
  const last = blocks.at(-1);
  const credit = `Credit: ${handle}`;
  if (last && /#[a-z0-9_]+/i.test(last) && blocks.length > 1) {
    return [...blocks.slice(0, -1), credit, last].join('\n\n');
  }
  return `${description}\n\n${credit}`;
}

export function fallbackDescriptions(
  candidate: ClipCandidate,
  title = fallbackCaption(candidate),
  creatorHandle?: string,
): PlatformDescriptions {
  const tags = candidateHashtags(candidate);
  const setup = title.endsWith('?') || title.endsWith('!') ? title : `${title} 😂`;
  return {
    tiktok: withCreatorAttribution(`${setup}\n\n${tags.slice(0, 7).join(' ')}`, creatorHandle),
    instagram: withCreatorAttribution(`${setup}\n\n${tags.slice(0, 8).join(' ')}`, creatorHandle),
  };
}

/**
 * Prompt input: the transcript, plus the punchline marked explicitly as the thing NOT to
 * give away. Knowing the payoff helps write a title/description that promises it; printing
 * it spoils it.
 */
export function captionInput(candidate: ClipCandidate): string {
  const transcript = candidate.transcriptText.slice(0, 600);
  const quote = candidate.quote?.trim();
  const context = [
    `Score: ${candidate.score}`,
    candidate.kind ? `Kind: ${candidate.kind}` : '',
    candidate.reason ? `Reason: ${candidate.reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const body = quote
    ? `Transcript: ${transcript}\n\nThe clip pays off on this line — do NOT give it away: ${quote}`
    : `Transcript: ${transcript}`;
  return context ? `${context}\n\n${body}` : body;
}

/**
 * The title card is the clip's hook. The platform descriptions are the upload text.
 */
export const CAPTION_SYSTEM =
  'You write the on-screen title card and TikTok/Instagram post descriptions for a short vertical livestream clip. ' +
  "The title is the clip's hook: a viewer reads it before they hear a word, and it is the only context they get.\n\n" +
  'Title rules: Write a PREMISE, not a punchline. Say what the clip is about — the scheme, argument, claim, or situation — and stop. ' +
  'Never quote the funny line, never state the outcome, never explain the joke. Style: 4-8 words, present tense, no full stop, at most one emoji.\n\n' +
  'Description rules: for TikTok and Instagram, write one short casual line that makes people watch, then 4-8 hashtags. ' +
  'The hashtags should help discovery: include a mix of broad tags (#fyp, #viral, #streamer, #livestream) and specific topic tags from the actual transcript. ' +
  'No fake names, no invented drama, no spam wall, no more than 8 hashtags. TikTok can be punchier; Instagram can be slightly cleaner. Always include hashtags.\n\n' +
  'Base everything ONLY on the transcript. Unfiltered/crude is fine if it is actually in the clip. ' +
  'Reply ONLY with JSON: {"caption": "<title>", "tiktok": "<description with hashtags>", "instagram": "<description with hashtags>"}.';

export interface CaptionWriterOptions {
  chat: ChatClient;
  model?: string;
  creatorHandle?: string;
}

export class LlmCaptionWriter implements CaptionWriter {
  private readonly chat: ChatClient;
  private readonly model: string;
  private readonly creatorHandle?: string;
  private readonly log = createLogger('caption');

  constructor(opts: CaptionWriterOptions) {
    this.chat = opts.chat;
    const cfg = getConfig();
    this.model = opts.model ?? cfg.llm.captionModel;
    this.creatorHandle = normalizeCreatorHandle(opts.creatorHandle ?? cfg.publish.creatorHandle);
  }

  async write(candidate: ClipCandidate): Promise<Caption> {
    try {
      const content = await this.chat.complete(
        [
          { role: 'system', content: CAPTION_SYSTEM },
          { role: 'user', content: captionInput(candidate) },
        ],
        { model: this.model, temperature: 0.7, maxTokens: 220, json: true },
      );
      const payload = parseCaptionPayload(content);
      if (payload.caption.length > 0) {
        const fallback = fallbackDescriptions(candidate, payload.caption, this.creatorHandle);
        return {
          text: payload.caption,
          descriptions: {
            tiktok: withCreatorAttribution(
              payload.tiktok ?? fallback.tiktok ?? payload.caption,
              this.creatorHandle,
            ),
            instagram: withCreatorAttribution(
              payload.instagram ?? fallback.instagram ?? payload.caption,
              this.creatorHandle,
            ),
          },
        };
      }
      this.log.warn({ id: candidate.id }, 'empty caption; using fallback');
    } catch (err) {
      this.log.warn({ id: candidate.id, err: (err as Error).message }, 'caption failed; fallback');
    }
    const text = fallbackCaption(candidate);
    return { text, descriptions: fallbackDescriptions(candidate, text, this.creatorHandle) };
  }
}

export function createCaptionWriter(opts: CaptionWriterOptions): CaptionWriter {
  return new LlmCaptionWriter(opts);
}
