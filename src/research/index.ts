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

export interface WindowOptions {
  minSec: number;
  maxSec: number;
  /** Preferred length; growth stops at the first sentence end past this. */
  targetSec: number;
  /** A silence gap (s) that also counts as a sentence/topic boundary. */
  gapSec?: number;
}

const SENTENCE_END = /[.!?…]['")\]]*$/;

/** True if the text looks like the end of a sentence. */
export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

/** A segment begins a clip if it opens a new sentence or follows a pause. */
function startsNewSentence(segments: TranscriptSegment[], i: number, gapSec: number): boolean {
  if (i === 0) return true;
  const prev = segments[i - 1];
  const cur = segments[i];
  if (!prev || !cur) return false;
  return endsSentence(prev.text) || cur.start - prev.end >= gapSec;
}

/**
 * Build clip windows that are **coherent and target-length**: each starts at a
 * sentence/topic boundary and ends at a sentence end (or a pause), growing toward
 * `targetSec` and staying within `[minSec, maxSec]`. This replaces the old "cut the
 * first 10s" behaviour that produced short, mid-sentence clips.
 */
export function buildWindows(
  segments: TranscriptSegment[],
  opts: WindowOptions = { minSec: CLIP_MIN_SEC, maxSec: CLIP_MAX_SEC, targetSec: 30 },
): WindowCandidate[] {
  const { minSec, maxSec, targetSec } = opts;
  const gapSec = opts.gapSec ?? 1.0;
  const windows: WindowCandidate[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (!startsNewSentence(segments, i, gapSec)) continue;
    const start = segments[i]?.start ?? 0;
    let acc = '';
    let best: WindowCandidate | undefined;

    for (let j = i; j < segments.length; j++) {
      const seg = segments[j];
      if (!seg) break;
      acc = acc ? `${acc} ${seg.text}` : seg.text;
      const dur = seg.end - start;
      if (dur > maxSec) break;

      const next = segments[j + 1];
      const isBreak =
        endsSentence(seg.text) ||
        j === segments.length - 1 ||
        (next ? next.start - seg.end >= gapSec : false);

      if (dur >= minSec && isBreak) {
        best = { startSec: start, endSec: seg.end, text: acc };
        if (dur >= targetSec) break; // long enough; end on this sentence
      }
    }
    if (best) windows.push(best);
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

/** Number of whitespace-separated words in a string. */
export function wordCount(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/**
 * Map speech density (words/second) to 0–100. Normal speech is ~2–3 wps, so
 * `targetWps` maps to 100; silence/applause (few words) scores near 0. This keeps
 * clips anchored to actual talking rather than raw noise (applause, music, cheers).
 */
export function speechDensityScore(wordsPerSec: number, targetWps = 3): number {
  return clamp((wordsPerSec / targetWps) * 100, 0, 100);
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

/**
 * Fast mean-RMS lookup over a loudness timeline: O(log n) per window via a prefix
 * sum + binary search, instead of scanning every sample. Essential on long VODs
 * (a 6-hour stream is ~240k samples). Averages samples whose start is in
 * `[startSec, endSec)`; returns the baseline when the window covers no sample.
 */
export function createLoudnessLookup(
  timeline: LoudnessTimeline,
): (startSec: number, endSec: number) => number {
  const { samples, baselineRms } = timeline;
  const n = samples.length;
  const starts = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    starts[i] = samples[i]?.start ?? 0;
    prefix[i + 1] = (prefix[i] ?? 0) + (samples[i]?.rms ?? 0);
  }
  const lowerBound = (t: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] ?? 0) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (startSec, endSec) => {
    const lo = lowerBound(startSec);
    const hi = lowerBound(endSec);
    if (hi <= lo) return baselineRms;
    return ((prefix[hi] ?? 0) - (prefix[lo] ?? 0)) / (hi - lo);
  };
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
  'You rate how good a short video clip this transcript snippet would make (0-10). ' +
  'High = a self-contained moment that is funny, surprising, quotable, or a high-energy ' +
  'reaction. Low = filler, mid-sentence, or nothing is really said. ' +
  'Reply ONLY with JSON: {"rating": <integer 0-10>, "reason": "<max 8 words>"}.';

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
  /** Minimum words/second a window must have to be considered (speech gate). */
  minWordsPerSec?: number;
  /** Clip length bounds / target (seconds); fall back to config. */
  minSec?: number;
  maxSec?: number;
  targetSec?: number;
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
  private readonly minWordsPerSec: number;
  private readonly minSec: number;
  private readonly maxSec: number;
  private readonly targetSec: number;
  private readonly rangeDb: number;
  private readonly shortlistMultiplier: number;
  private readonly log = createLogger('research');

  constructor(opts: ClipDetectorOptions) {
    const cfg = getConfig();
    this.scorer = opts.scorer;
    this.loudnessWeight = opts.loudnessWeight ?? cfg.scoring.loudnessWeight;
    this.transcriptWeight = opts.transcriptWeight ?? cfg.scoring.transcriptWeight;
    this.minScore = opts.minScore ?? cfg.scoring.minScore;
    this.maxCandidates = opts.maxCandidates ?? cfg.scoring.maxCandidates;
    this.minWordsPerSec = opts.minWordsPerSec ?? cfg.scoring.minWordsPerSec;
    this.minSec = opts.minSec ?? cfg.clip.minSec;
    this.maxSec = opts.maxSec ?? cfg.clip.maxSec;
    this.targetSec = opts.targetSec ?? cfg.clip.targetSec;
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

    const windows = buildWindows(transcript.segments, {
      minSec: this.minSec,
      maxSec: this.maxSec,
      targetSec: this.targetSec,
    });
    const meanRms = createLoudnessLookup(loudness);
    const scored = windows.map((w) => {
      const dur = Math.max(w.endSec - w.startSec, 0.001);
      const wps = wordCount(w.text) / dur;
      return {
        w,
        wps,
        loud: loudnessScore(meanRms(w.startSec, w.endSec), loudness.baselineRms, this.rangeDb),
        speech: speechDensityScore(wps),
      };
    });

    // Speech gate: drop windows without enough talking (kills applause/music/cheers
    // that are loud but have no content). Then pre-rank on loudness AND speech so both
    // punchy spoken moments and high-energy reactions surface — not just the loudest.
    const withSpeech = scored.filter((s) => s.wps >= this.minWordsPerSec);
    const preRanked = withSpeech
      .map((s) => ({
        ...s,
        pre: combineScores(s.loud, s.speech, this.loudnessWeight, this.transcriptWeight),
      }))
      .sort((a, b) => b.pre - a.pre);
    const shortlist = preRanked.slice(0, Math.max(limit * this.shortlistMultiplier, limit));
    this.log.info(
      {
        windows: windows.length,
        withSpeech: withSpeech.length,
        shortlist: shortlist.length,
        limit,
      },
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
