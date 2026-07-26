/**
 * Research module: decides *when to trigger a clip*. Implements {@link ClipDetector}.
 *
 * Selection is **content-first**. What was said picks the clips; loudness only breaks
 * ties between windows the rater already liked about equally:
 *   1. Build coherent, sentence-aligned windows over the transcript.
 *   2. Gate out windows with no real speech (applause, music, dead air).
 *   3. Thin near-duplicate overlapping windows so rating spend isn't wasted.
 *   4. Rank what's left by the free lexical prescreen and keep the top `llmScoreBudget`.
 *   5. Batch-rate those on transcript content (0–100) with a small LLM.
 *   6. Combine (transcript-dominant), trim each clip to end on its punchline, threshold,
 *      de-overlap, return the top N.
 *
 * The ordering matters. An earlier version ranked windows by loudness and only showed the
 * loudest ~40 to the LLM, which meant content could reorder a loudness shortlist but never
 * select against it: anything said quietly was unreachable no matter how good it was.
 * Steps 3–4 replace that gate with a text-based one, so the funniest quiet moment in a
 * six-hour VOD can still win.
 */
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
import { createPrescreen } from './prescreen.js';
import { NEUTRAL_SCORE, type ScoredText, type TranscriptScorer } from './scorer.js';

export * from './prescreen.js';
export * from './scorer.js';

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
 * `targetSec` and staying within `[minSec, maxSec]`.
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

/**
 * Keep windows whose starts are at least `strideSec` apart, in transcript order.
 *
 * buildWindows emits one window per sentence boundary, so consecutive windows overlap
 * almost entirely and say nearly the same thing. Rating all of them burns the budget on
 * duplicates that dedupeOverlapping would discard afterwards anyway.
 */
export function thinByStride<T extends { startSec: number }>(
  windows: readonly T[],
  strideSec: number,
): T[] {
  if (strideSec <= 0) return [...windows];
  const kept: T[] = [];
  let lastStart = -Infinity;
  for (const w of windows) {
    if (w.startSec - lastStart >= strideSec) {
      kept.push(w);
      lastStart = w.startSec;
    }
  }
  return kept;
}

/** Lowercase and strip punctuation so quote matching survives transcript formatting. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Trim trailing talk that follows the punchline, so a clip ends on the line that makes it
 * rather than on whatever was said next.
 *
 * Deliberately conservative — sentence-aligned windows are why clips read as coherent, so
 * this only cuts on a segment boundary, only when the quote is actually found, only when
 * it saves real time, and never below `minSec`.
 */
export function trimTrailingAfterQuote(
  window: WindowCandidate,
  quote: string,
  segments: readonly TranscriptSegment[],
  minSec: number,
  minSavingSec = 2,
): WindowCandidate {
  const needle = normalize(quote);
  if (needle.length < 12) return window;

  const inWindow = segments.filter(
    (s) => s.start >= window.startSec && s.end <= window.endSec + 0.001,
  );
  // Walk forward and stop at the first segment by which the quote has fully appeared.
  let acc = '';
  for (const [i, seg] of inWindow.entries()) {
    acc = acc ? `${acc} ${normalize(seg.text)}` : normalize(seg.text);
    if (!acc.includes(needle)) continue;
    if (window.endSec - seg.end < minSavingSec) return window;
    if (seg.end - window.startSec < minSec) return window;
    return {
      startSec: window.startSec,
      endSec: seg.end,
      text: inWindow
        .slice(0, i + 1)
        .map((s) => s.text)
        .join(' '),
    };
  }
  return window;
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

export interface ClipDetectorOptions {
  scorer: TranscriptScorer;
  loudnessWeight?: number;
  transcriptWeight?: number;
  minScore?: number;
  maxCandidates?: number;
  /** Minimum words/second a window must have to be considered (speech gate). */
  minWordsPerSec?: number;
  /** Max windows to send for LLM rating. */
  llmScoreBudget?: number;
  /** Min seconds between the starts of two rated windows. */
  strideSec?: number;
  /** Extra prescreen terms for this streamer. */
  spiceWords?: readonly string[];
  fillerWords?: readonly string[];
  /** Drop candidates the rater flags as unpostable. */
  dropUnpostable?: boolean;
  /** Clip length bounds / target (seconds); fall back to config. */
  minSec?: number;
  maxSec?: number;
  targetSec?: number;
  /** dB above baseline that maps loudness to 100. */
  loudnessRangeDb?: number;
}

export class ScoringClipDetector implements ClipDetector {
  private readonly scorer: TranscriptScorer;
  private readonly loudnessWeight: number;
  private readonly transcriptWeight: number;
  private readonly minScore: number;
  private readonly maxCandidates: number;
  private readonly minWordsPerSec: number;
  private readonly llmScoreBudget: number;
  private readonly strideSec: number;
  private readonly spiceWords: readonly string[];
  private readonly fillerWords: readonly string[];
  private readonly dropUnpostable: boolean;
  private readonly minSec: number;
  private readonly maxSec: number;
  private readonly targetSec: number;
  private readonly rangeDb: number;
  private readonly log = createLogger('research');

  constructor(opts: ClipDetectorOptions) {
    const cfg = getConfig();
    this.scorer = opts.scorer;
    this.loudnessWeight = opts.loudnessWeight ?? cfg.scoring.loudnessWeight;
    this.transcriptWeight = opts.transcriptWeight ?? cfg.scoring.transcriptWeight;
    this.minScore = opts.minScore ?? cfg.scoring.minScore;
    this.maxCandidates = opts.maxCandidates ?? cfg.scoring.maxCandidates;
    this.minWordsPerSec = opts.minWordsPerSec ?? cfg.scoring.minWordsPerSec;
    this.llmScoreBudget = opts.llmScoreBudget ?? cfg.scoring.llmScoreBudget;
    this.strideSec = opts.strideSec ?? cfg.scoring.strideSec;
    this.spiceWords = opts.spiceWords ?? cfg.scoring.spiceWords;
    this.fillerWords = opts.fillerWords ?? cfg.scoring.fillerWords;
    this.dropUnpostable = opts.dropUnpostable ?? cfg.scoring.dropUnpostable;
    this.minSec = opts.minSec ?? cfg.clip.minSec;
    this.maxSec = opts.maxSec ?? cfg.clip.maxSec;
    this.targetSec = opts.targetSec ?? cfg.clip.targetSec;
    this.rangeDb = opts.loudnessRangeDb ?? 12;
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

    // Speech gate: no talking, no clip. Kills applause/music/cheering, which are loud but
    // say nothing — and which a loudness-led detector reliably mistakes for gold.
    const speaking = windows.filter((w) => {
      const dur = Math.max(w.endSec - w.startSec, 0.001);
      return wordCount(w.text) / dur >= this.minWordsPerSec;
    });
    const thinned = thinByStride(speaking, this.strideSec);

    // Choose who gets rated, on *content*. Only bites when there are more windows than
    // budget; under the cap every speaking window is rated and the prescreen is a no-op.
    let selected = thinned;
    if (thinned.length > this.llmScoreBudget) {
      const prescreen = createPrescreen(
        thinned.map((w) => w.text),
        { spiceWords: this.spiceWords, fillerWords: this.fillerWords },
      );
      selected = thinned
        .map((w) => ({ w, pre: prescreen.score(w.text, w.endSec - w.startSec).score }))
        .sort((a, b) => b.pre - a.pre)
        .slice(0, this.llmScoreBudget)
        .map((s) => s.w);
    }
    this.log.info(
      {
        windows: windows.length,
        speaking: speaking.length,
        thinned: thinned.length,
        rated: selected.length,
        limit,
      },
      'rating windows on transcript content',
    );

    const ratings = await this.scorer.scoreBatch(selected.map((w) => w.text));
    const meanRms = createLoudnessLookup(loudness);

    const candidates: ClipCandidate[] = [];
    let droppedUnpostable = 0;
    for (const [i, w] of selected.entries()) {
      const rating: ScoredText = ratings[i] ?? { ...NEUTRAL_SCORE };
      if (rating.unpostable && this.dropUnpostable) {
        droppedUnpostable++;
        continue;
      }
      const trimmed = trimTrailingAfterQuote(w, rating.quote, transcript.segments, this.minSec);
      const loud = loudnessScore(
        meanRms(trimmed.startSec, trimmed.endSec),
        loudness.baselineRms,
        this.rangeDb,
      );
      const score = combineScores(loud, rating.score, this.loudnessWeight, this.transcriptWeight);
      candidates.push({
        id: `${transcript.sourceId}-${trimmed.startSec.toFixed(1)}`,
        sourceId: transcript.sourceId,
        startSec: trimmed.startSec,
        endSec: trimmed.endSec,
        score: Math.round(score),
        reason: rating.reason || rating.kind,
        transcriptText: trimmed.text,
        kind: rating.kind,
        quote: rating.quote,
        unpostable: rating.unpostable,
      });
    }

    const ranked = candidates.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score);
    const result = dedupeOverlapping(ranked).slice(0, limit);
    this.log.info(
      { candidates: result.length, aboveThreshold: ranked.length, droppedUnpostable },
      'detection complete',
    );
    return result;
  }
}

export function createClipDetector(opts: ClipDetectorOptions): ClipDetector {
  return new ScoringClipDetector(opts);
}
