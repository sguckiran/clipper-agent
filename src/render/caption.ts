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
 * Deterministic caption used when the LLM is unavailable. Prefers the rater's punchline
 * quote — it is the line the clip exists for, so it beats the first eight words, which
 * are usually the setup.
 */
export function fallbackCaption(candidate: ClipCandidate): string {
  const quote = candidate.quote?.trim();
  if (quote) return quote.split(/\s+/).slice(0, 12).join(' ');
  const words = candidate.transcriptText.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length > 0) return words.join(' ');
  return candidate.reason || 'You have to see this';
}

/** Prompt input: the transcript, plus the punchline to build the caption around. */
export function captionInput(candidate: ClipCandidate): string {
  const quote = candidate.quote?.trim();
  const transcript = candidate.transcriptText.slice(0, 600);
  return quote ? `Punchline: ${quote}\n\nTranscript: ${transcript}` : transcript;
}

const CAPTION_SYSTEM =
  'You write one short, catchy caption for a vertical video clip, based ONLY on the ' +
  'transcript given. It must accurately reflect what is actually said — do NOT invent ' +
  'names, events, or drama. Engaging but truthful. When a punchline line is provided, ' +
  "build the caption around that moment. Match the clip's own register: these are " +
  'unfiltered streams, so blunt and crude is fine and sanitising it makes a worse ' +
  'caption. Reply ONLY with JSON: {"caption": "<max 12 words, no hashtags, no quotes>"}.';

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
