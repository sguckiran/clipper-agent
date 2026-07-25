/**
 * Loudness module: measures a source's audio-energy profile with ffmpeg's
 * `ebur128` filter. Implements the {@link LoudnessAnalyzer} contract. This is the
 * primary clip-worthiness signal — loud moments relative to the source baseline
 * (crowd reactions, laughter, shouting) are what "trigger" a clip.
 *
 * No LLM involved; fully deterministic and unit-tested by parsing fixed ffmpeg
 * output.
 */
import type { LoudnessAnalyzer } from '../core/contracts.js';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { ffmpegBinary } from '../core/platform.js';
import type { LoudnessSample, LoudnessTimeline, SourceVideo } from '../core/types.js';

/** ffmpeg momentary-loudness window is ~100 ms; used as each sample's width. */
const SLICE_SEC = 0.1;
/** Floor (LUFS) substituted for silence (`-inf`) so math stays finite. */
const SILENCE_FLOOR = -120;

/** ffmpeg argv that streams per-window loudness to stderr and discards output. */
export function buildLoudnessArgs(input: string): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    input,
    '-filter_complex',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ];
}

function toFinite(raw: string, floor: number): number {
  if (raw.includes('inf')) return floor;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : floor;
}

/** Parse ffmpeg `ebur128` stderr into a loudness sample per printed interval. */
export function parseEbur128(stderr: string, sliceSec = SLICE_SEC): LoudnessSample[] {
  const samples: LoudnessSample[] = [];
  for (const line of stderr.split('\n')) {
    const tMatch = line.match(/t:\s*([0-9]+(?:\.[0-9]+)?)/);
    const mMatch = line.match(/M:\s*(-?[0-9]+(?:\.[0-9]+)?|-?inf)/);
    if (!tMatch?.[1] || !mMatch?.[1]) continue;
    const start = Number.parseFloat(tMatch[1]);
    const rms = toFinite(mMatch[1], SILENCE_FLOOR);
    let peak = rms;
    const pMatch = line.match(/FTPK:\s*(-?[0-9.]+|-?inf)(?:\s+(-?[0-9.]+|-?inf))?/);
    if (pMatch?.[1]) {
      const a = toFinite(pMatch[1], SILENCE_FLOOR);
      const b = pMatch[2] ? toFinite(pMatch[2], SILENCE_FLOOR) : a;
      peak = Math.max(a, b);
    }
    samples.push({ start, end: start + sliceSec, rms, peak });
  }
  return samples;
}

/** Median of a list (used for the loudness baseline). Returns 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return sorted[mid] ?? 0;
}

export interface LoudnessAnalyzerOptions {
  runner?: CommandRunner;
  ffmpeg?: string;
}

export class FfmpegLoudnessAnalyzer implements LoudnessAnalyzer {
  private readonly runner: CommandRunner;
  private readonly ffmpeg: string;
  private readonly log = createLogger('loudness');

  constructor(opts: LoudnessAnalyzerOptions = {}) {
    this.runner = opts.runner ?? execaRunner;
    this.ffmpeg = opts.ffmpeg ?? ffmpegBinary();
  }

  async analyze(source: SourceVideo): Promise<LoudnessTimeline> {
    this.log.info({ id: source.id }, 'analyzing loudness');
    // ebur128 writes to stderr; -f null discards the decoded output.
    const { stderr } = await this.runner.run(this.ffmpeg, buildLoudnessArgs(source.localPath), {
      reject: false,
    });
    const samples = parseEbur128(stderr);
    const baselineRms = median(samples.map((s) => s.rms));
    this.log.info({ id: source.id, samples: samples.length, baselineRms }, 'loudness ready');
    return { sourceId: source.id, samples, baselineRms };
  }
}

export function createLoudnessAnalyzer(opts?: LoudnessAnalyzerOptions): LoudnessAnalyzer {
  return new FfmpegLoudnessAnalyzer(opts);
}
