/**
 * Research module: decides *when to trigger a clip*. Implements {@link ClipDetector}.
 *
 * Scoring is loudness-primary + a tiny LLM confirm, combined per configured weights
 * (default 50/50):
 *   1. Slide over transcript segments to build valid 10–20s windows.
 *   2. Score each window's loudness (deterministic, from the ffmpeg timeline).
 *   3. Shortlist the loudest windows and ask a tiny LLM to rate the transcript text.
 *   4. Combine, threshold on minScore, de-overlap, and return the top N candidates.
 *
 * The LLM prompt is deliberately minimal so a small, cheap model handles it; if the
 * scorer fails, the window still scores on loudness with a neutral text score.
 */
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import type { ClipDetector, DetectOptions } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import {
  CLIP_MAX_SEC,
  CLIP_MIN_SEC,
  isValidClipLength,
  windowMeanRms,
  type ClipCandidate,
  type LoudnessTimeline,
  type Transcript,
  type TranscriptSegment,
} from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';

export interface ScoredText {
  /** 0–10 clip-worthiness of the transcript text. */
  rating: number;
  /** Very short rationale. */
  reason: string;
}

/** Rates a short transcript snippet. Backed by a tiny LLM (see createChatScorer). */
export interface TranscriptScorer {
  score(text: string): Promise<ScoredText>;
}

export interface WindowCandidate {
  startSec: number;
  endSec: number;
  text: string;
}

/** Slide over segments producing one valid 10–20s window per anchor segment. */
export function buildWindows(segments: TranscriptSegment[]): WindowCandidate[] {
  const windows: WindowCandidate[] = [];
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i]?.start ?? 0;
    let text = '';
    for (let j = i; j < segments.length; j++) {
      const seg = segments[j];
      if (!seg) break;
      text = text ? `${text} ${seg.text}` : seg.text;
      const dur = seg.end - start;
      if (dur > CLIP_MAX_SEC) {
        // A single/last segment overran the max; cap to a valid-length window.
        const capped = { startSec: start, endSec: start + CLIP_MAX_SEC, text };
        if (isValidClipLength(capped)) windows.push(capped);
        break;
      }
      if (dur >= CLIP_MIN_SEC) {
        windows.push({ startSec: start, endSec: seg.end, text });
        break; // shortest valid window for this anchor
      }
    }
  }
  return windows;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Map a window's mean loudness to 0–100 relative to the source baseline.
 * `rangeDb` above baseline → 100; at baseline → 50; `rangeDb` below → 0.
 */
export function loudnessScore(meanRms: number, baseline: number, rangeDb = 12): number {
  const rel = (meanRms - baseline) / rangeDb;
  return clamp(50 + rel * 50, 0, 100);
}

/** Weighted combination of the two 0–100 signals, normalized by the weight sum. */
export function combineScores(
  loud: number,
  text: number,
  loudnessWeight: number,
  transcriptWeight: number,
): number {
  const total = loudnessWeight + transcriptWeight;
  if (total <= 0) return 0;
  return (loud * loudnessWeight + text * transcriptWeight) / total;
}

/** Greedily keep the highest-scoring non-overlapping candidates (input sorted desc). */
export function dedupeOverlapping(sortedDesc: ClipCandidate[]): ClipCandidate[] {
  const kept: ClipCandidate[] = [];
  for (const c of sortedDesc) {
    const overlaps = kept.some((k) => c.startSec < k.endSec && c.endSec > k.startSec);
    if (!overlaps) kept.push(c);
  }
  return kept;
}

const scoreSchema = z.object({
  rating: z.coerce.number(),
  reason: z.string().default(''),
});

/** Parse a tiny-LLM JSON rating, clamping to 0–10. Throws on unparseable input. */
export function parseScore(raw: string): ScoredText {
  const parsed = scoreSchema.parse(JSON.parse(raw));
  return { rating: clamp(parsed.rating, 0, 10), reason: parsed.reason.trim() };
}

const SCORER_SYSTEM =
  'You rate how likely a short livestream transcript snippet is to go viral as a clip. ' +
  'Reply ONLY with JSON: {"rating": <integer 0-10>, "reason": "<max 8 words>"}. ' +
  'Higher = funnier, more shocking, more quotable.';

/** Build a {@link TranscriptScorer} from a chat client + small model name. */
export function createChatScorer(chat: ChatClient, model: string): TranscriptScorer {
  return {
    async score(text) {
      const content = await chat.complete(
        [
          { role: 'system', content: SCORER_SYSTEM },
          { role: 'user', content: text.slice(0, 500) },
        ],
        { model, temperature: 0, maxTokens: 60, json: true },
      );
      return parseScore(content);
    },
  };
}

export interface ClipDetectorOptions {
  scorer: TranscriptScorer;
  loudnessWeight?: number;
  transcriptWeight?: number;
  minScore?: number;
  maxCandidates?: number;
  /** dB above baseline that maps loudness to 100. */
  loudnessRangeDb?: number;
  /** Shortlist size (for LLM scoring) as a multiple of the candidate limit. */
  shortlistMultiplier?: number;
}

export class ScoringClipDetector implements ClipDetector {
  private readonly scorer: TranscriptScorer;
  private readonly loudnessWeight: number;
  private readonly transcriptWeight: number;
  private readonly minScore: number;
  private readonly maxCandidates: number;
  private readonly rangeDb: number;
  private readonly shortlistMultiplier: number;
  private readonly log = createLogger('research');

  constructor(opts: ClipDetectorOptions) {
    const cfg = getConfig().scoring;
    this.scorer = opts.scorer;
    this.loudnessWeight = opts.loudnessWeight ?? cfg.loudnessWeight;
    this.transcriptWeight = opts.transcriptWeight ?? cfg.transcriptWeight;
    this.minScore = opts.minScore ?? cfg.minScore;
    this.maxCandidates = opts.maxCandidates ?? cfg.maxCandidates;
    this.rangeDb = opts.loudnessRangeDb ?? 12;
    this.shortlistMultiplier = opts.shortlistMultiplier ?? 4;
  }

  async detect(
    transcript: Transcript,
    loudness: LoudnessTimeline,
    opts: DetectOptions = {},
  ): Promise<ClipCandidate[]> {
    const limit = opts.limit ?? this.maxCandidates;
    const minScore = opts.minScore ?? this.minScore;

    const windows = buildWindows(transcript.segments);
    // Rank by loudness first (free), then only LLM-score the loudest shortlist.
    const byLoudness = windows
      .map((w) => ({
        w,
        loud: loudnessScore(windowMeanRms(loudness, w), loudness.baselineRms, this.rangeDb),
      }))
      .sort((a, b) => b.loud - a.loud);
    const shortlist = byLoudness.slice(0, Math.max(limit * this.shortlistMultiplier, limit));
    this.log.info(
      { windows: windows.length, shortlist: shortlist.length, limit },
      'scoring shortlist',
    );

    const candidates: ClipCandidate[] = [];
    for (const { w, loud } of shortlist) {
      let text: ScoredText;
      try {
        text = await this.scorer.score(w.text);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'text scorer failed; using neutral score');
        text = { rating: 5, reason: '(text scorer unavailable)' };
      }
      const score = combineScores(
        loud,
        text.rating * 10,
        this.loudnessWeight,
        this.transcriptWeight,
      );
      candidates.push({
        id: `${transcript.sourceId}-${w.startSec.toFixed(1)}`,
        sourceId: transcript.sourceId,
        startSec: w.startSec,
        endSec: w.endSec,
        score: Math.round(score),
        reason: text.reason || `loud moment (${Math.round(loud)}/100)`,
        transcriptText: w.text,
      });
    }

    const ranked = candidates.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score);
    const result = dedupeOverlapping(ranked).slice(0, limit);
    this.log.info({ candidates: result.length }, 'detection complete');
    return result;
  }
}

export function createClipDetector(opts: ClipDetectorOptions): ClipDetector {
  return new ScoringClipDetector(opts);
}
