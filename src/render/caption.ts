/**
 * Caption writer: turns a clip candidate into a short, sensationalist caption via
 * a tiny LLM. Implements {@link CaptionWriter}. The prompt is minimal so a small
 * model handles it; on any failure it falls back to a caption derived from the
 * transcript so the pipeline never stalls on the LLM.
 */
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import type { CaptionWriter } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import type { Caption, ClipCandidate } from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';

const captionSchema = z.object({ caption: z.string() });

/** Parse the tiny-LLM JSON caption reply. Throws on unparseable input. */
export function parseCaption(raw: string): string {
  return captionSchema.parse(JSON.parse(raw)).caption.trim();
}

/**
 * Deterministic caption used when the LLM is unavailable.
 *
 * Falls back to the *opening* words rather than the punchline quote: the caption is a title
 * that sets the clip up, so echoing the payoff is worse than a plain premise. See
 * {@link CAPTION_SYSTEM}.
 */
export function fallbackCaption(candidate: ClipCandidate): string {
  const words = candidate.transcriptText.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length > 0) return words.join(' ');
  return candidate.reason || 'You have to see this';
}

/**
 * Prompt input: the transcript, plus the punchline marked explicitly as the thing NOT to
 * give away. Knowing the payoff helps write a title that promises it; printing it spoils it.
 */
export function captionInput(candidate: ClipCandidate): string {
  const transcript = candidate.transcriptText.slice(0, 600);
  const quote = candidate.quote?.trim();
  return quote
    ? `Transcript: ${transcript}\n\nThe clip pays off on this line — do NOT give it away: ${quote}`
    : `Transcript: ${transcript}`;
}

/**
 * The title card is the clip's hook.
 *
 * This is a *premise*, not a punchline. A successful reference clip is titled "Krimoe plan to
 * go international ✈️" — it says what the clip is about and nothing more, which is what lets
 * the video cold-open mid-sentence without confusing anyone. Quoting the payoff instead
 * produces fragments like "Same mother's life after this": accurate to the transcript,
 * useless as a title, and it spoils the thing the viewer was staying for.
 */
export const CAPTION_SYSTEM =
  'You write the on-screen title card for a short vertical clip from a livestream. It is the ' +
  "clip's hook: a viewer reads it before they have heard a word, and it is the only context " +
  'they get, because the video cold-opens mid-conversation.\n\n' +
  'Write a PREMISE, not a punchline. Say what the clip is ABOUT — the scheme, the argument, ' +
  'the claim, the situation — and stop. Never quote the funny line, never state the outcome, ' +
  'never explain the joke. The title makes someone want the payoff; it does not deliver it.\n\n' +
  'Style: a headline, 4-8 words, present tense, no full stop, at most one emoji. Casual ' +
  'register is right. Example of the target: "Krimoe plan to go international"\n\n' +
  'Base it ONLY on the transcript. Do NOT invent names, events or drama. These are ' +
  'unfiltered streams, so blunt and crude is fine and sanitising it makes a worse title. ' +
  'Reply ONLY with JSON: {"caption": "<the title>"}.';

export interface CaptionWriterOptions {
  chat: ChatClient;
  model?: string;
}

export class LlmCaptionWriter implements CaptionWriter {
  private readonly chat: ChatClient;
  private readonly model: string;
  private readonly log = createLogger('caption');

  constructor(opts: CaptionWriterOptions) {
    this.chat = opts.chat;
    this.model = opts.model ?? getConfig().llm.captionModel;
  }

  async write(candidate: ClipCandidate): Promise<Caption> {
    try {
      const content = await this.chat.complete(
        [
          { role: 'system', content: CAPTION_SYSTEM },
          { role: 'user', content: captionInput(candidate) },
        ],
        { model: this.model, temperature: 0.7, maxTokens: 60, json: true },
      );
      const text = parseCaption(content);
      if (text.length > 0) return { text };
      this.log.warn({ id: candidate.id }, 'empty caption; using fallback');
    } catch (err) {
      this.log.warn({ id: candidate.id, err: (err as Error).message }, 'caption failed; fallback');
    }
    return { text: fallbackCaption(candidate) };
  }
}

export function createCaptionWriter(opts: CaptionWriterOptions): CaptionWriter {
  return new LlmCaptionWriter(opts);
}
