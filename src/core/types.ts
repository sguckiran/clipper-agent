/**
 * Shared domain types for the clipper-agent pipeline.
 *
 * The pipeline flows:
 *   SourceVideo -> Transcript -> ClipCandidate[] -> Clip (rendered) -> PublishResult[]
 *
 * Every module implements a contract in {@link ./contracts.ts} that speaks these types.
 */

/** Where a source livestream/VOD came from. */
export type SourcePlatform = 'twitch' | 'youtube' | 'kick' | 'other';

/** Targets we publish finished clips to. */
export type PublishTarget = 'tiktok' | 'instagram' | 'youtube';

/** A downloaded long-form source video (e.g. a 2h stream VOD). */
export interface SourceVideo {
  /** Stable id, typically derived from the source URL. */
  id: string;
  url: string;
  platform: SourcePlatform;
  title: string;
  /** Duration of the source in seconds. */
  durationSec: number;
  /** Absolute path to the downloaded media file on disk. */
  localPath: string;
  /** ISO timestamp of when the download completed. */
  downloadedAt: string;
}

/** A single transcribed word with timing, when word-level data is available. */
export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

/** A transcribed segment (sentence-ish chunk) with start/end in seconds. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

/** Full transcript of a source video. */
export interface Transcript {
  sourceId: string;
  /** BCP-47-ish language code as reported by the transcriber. */
  language: string;
  segments: TranscriptSegment[];
  /** Concatenated plain text of all segments. */
  fullText: string;
}

/** A loudness measurement over a short, fixed-width slice of a source's audio. */
export interface LoudnessSample {
  /** Slice start in seconds. */
  start: number;
  /** Slice end in seconds. */
  end: number;
  /** RMS loudness in dBFS (negative; louder is closer to 0). */
  rms: number;
  /** Peak loudness in dBFS for the slice. */
  peak: number;
}

/**
 * Loudness profile of a source video, produced by a LoudnessAnalyzer.
 * Loud moments relative to {@link baselineRms} are the primary clip-worthiness signal.
 */
export interface LoudnessTimeline {
  sourceId: string;
  /** Fixed-width slices in chronological order. */
  samples: LoudnessSample[];
  /** Median RMS across the source (dBFS), used as the "normal" baseline. */
  baselineRms: number;
}

/**
 * A candidate window the research agent thinks is clip-worthy.
 * Must satisfy the configured clip-length rule by the time it is rendered.
 */
export interface ClipCandidate {
  id: string;
  sourceId: string;
  startSec: number;
  endSec: number;
  /** Virality score, 0–100. Higher is more clip-worthy. */
  score: number;
  /** Short rationale from the research agent for why this is clippable. */
  reason: string;
  /** Transcript text covered by the window. */
  transcriptText: string;
  /** Word-level transcript covered by the window, when the transcriber provided timings. */
  words?: TranscriptWord[];
  /** Moment type from the rater, e.g. 'story' | 'take' | 'rant' | 'reaction'. */
  kind?: string;
  /** The verbatim line the clip pays off on; the caption's best hook. */
  quote?: string;
  /** The verbatim line the clip should open on, per the rater. */
  hookQuote?: string;
  /** Skill axis scores, 0–100 each: funny, hook, out-of-pocket, standalone coherence. */
  funny?: number;
  hook?: number;
  pocket?: number;
  coherence?: number;
  /** Optional render hint from the rater, e.g. stack two webcam panels for Omegle clips. */
  renderLayout?: 'stack' | 'default';
  /** Rater's guess that posting this as-is would get an account actioned. */
  unpostable?: boolean;
}

/** A sensationalist caption to burn onto a clip. */
export interface Caption {
  /** The on-screen caption text. */
  text: string;
  /** Optional style hint for the renderer (font, placement, etc.). */
  style?: CaptionStyle;
}

export interface CaptionStyle {
  fontFamily?: string;
  fontSizePx?: number;
  /** Hex color, e.g. "#FFFFFF". */
  color?: string;
  /** 'top' | 'center' | 'bottom' */
  position?: 'top' | 'center' | 'bottom';
}

export type ClipStatus =
  | 'candidate'
  | 'captioned'
  | 'rendered'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'failed';

/** A clip moving through the pipeline. */
export interface Clip {
  id: string;
  candidateId: string;
  sourceId: string;
  startSec: number;
  endSec: number;
  caption: Caption;
  /** Original scored candidate metadata, kept for review UIs and ranking. */
  candidate?: ClipCandidate;
  /** Absolute path to the rendered vertical clip, once produced. */
  renderedPath?: string;
  status: ClipStatus;
}

export interface PublishResult {
  target: PublishTarget;
  status: 'published' | 'failed' | 'skipped';
  /** Public URL of the post, when available. */
  url?: string;
  /** Platform-native post id, when available. */
  postId?: string;
  error?: string;
}

/** Default clip length bounds (seconds). Overridable via config (CLIPPER_CLIP_*). */
export const CLIP_MIN_SEC = 15;
export const CLIP_MAX_SEC = 60;

/** Returns the duration of a candidate/clip window in seconds. */
export function windowDurationSec(window: { startSec: number; endSec: number }): number {
  return window.endSec - window.startSec;
}

/** True if a window's duration falls within [minSec, maxSec] (defaults to the constants). */
export function isValidClipLength(
  window: { startSec: number; endSec: number },
  minSec: number = CLIP_MIN_SEC,
  maxSec: number = CLIP_MAX_SEC,
): boolean {
  const d = windowDurationSec(window);
  return d >= minSec && d <= maxSec;
}

/**
 * Mean RMS (dBFS) of the loudness samples overlapping a window. Returns the
 * timeline baseline when no sample overlaps (e.g. a gap in the audio profile).
 */
export function windowMeanRms(
  timeline: LoudnessTimeline,
  window: { startSec: number; endSec: number },
): number {
  const overlapping = timeline.samples.filter(
    (s) => s.end > window.startSec && s.start < window.endSec,
  );
  if (overlapping.length === 0) return timeline.baselineRms;
  const sum = overlapping.reduce((acc, s) => acc + s.rms, 0);
  return sum / overlapping.length;
}
