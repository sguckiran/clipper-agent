import { execFile } from 'node:child_process';
import type { PanelRect, SpeakerFocusSegment } from './layout.js';

export interface SpeakerAnalysisOptions {
  ffmpeg: string;
  fps?: number;
  width?: number;
}

export type SpeakerFocusAnalyzer = (
  input: string,
  startSec: number,
  endSec: number,
  panels: readonly PanelRect[],
  opts: SpeakerAnalysisOptions,
) => Promise<SpeakerFocusSegment[]>;

function execFileBuffer(file: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'buffer', maxBuffer: 80 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function scaledHeight(panel: PanelRect, width: number): number {
  return Math.max(2, Math.floor((panel.h * width) / panel.w / 2) * 2);
}

async function panelMotion(
  input: string,
  startSec: number,
  durationSec: number,
  panel: PanelRect,
  opts: Required<SpeakerAnalysisOptions>,
): Promise<number[]> {
  const h = scaledHeight(panel, opts.width);
  const frameBytes = opts.width * h;
  const raw = await execFileBuffer(opts.ffmpeg, [
    '-v',
    'error',
    '-ss',
    startSec.toString(),
    '-i',
    input,
    '-t',
    durationSec.toString(),
    '-an',
    '-vf',
    `crop=${panel.w}:${panel.h}:${panel.x}:${panel.y},scale=${opts.width}:${h}:flags=fast_bilinear,format=gray,fps=${opts.fps}`,
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  const frames = Math.floor(raw.length / frameBytes);
  const out: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    if (frame === 0) {
      out.push(0);
      continue;
    }
    const prev = (frame - 1) * frameBytes;
    const cur = frame * frameBytes;
    let diff = 0;
    for (let i = 0; i < frameBytes; i += 4) {
      diff += Math.abs((raw[cur + i] ?? 0) - (raw[prev + i] ?? 0));
    }
    out.push(diff / (frameBytes / 4));
  }
  return out;
}

function mergeSegments(raw: SpeakerFocusSegment[], minSec: number): SpeakerFocusSegment[] {
  const firstPass: SpeakerFocusSegment[] = [];
  for (const seg of raw) {
    const prev = firstPass.at(-1);
    if (prev && prev.panel === seg.panel && Math.abs(prev.endSec - seg.startSec) < 0.001) {
      prev.endSec = seg.endSec;
    } else {
      firstPass.push({ ...seg });
    }
  }

  for (let i = 1; i < firstPass.length - 1; i++) {
    const seg = firstPass[i]!;
    const prev = firstPass[i - 1]!;
    const next = firstPass[i + 1]!;
    if (seg.endSec - seg.startSec < minSec && prev.panel === next.panel) {
      seg.panel = prev.panel;
    }
  }

  const merged: SpeakerFocusSegment[] = [];
  for (const seg of firstPass) {
    const prev = merged.at(-1);
    if (prev && prev.panel === seg.panel && Math.abs(prev.endSec - seg.startSec) < 0.001) {
      prev.endSec = seg.endSec;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Cheap active-speaker estimate for two-person Omegle layouts.
 *
 * It compares frame-to-frame motion inside each configured panel. The assumption is that
 * the speaking face/mouth tends to move more than the listening face. It is not diarization,
 * but it is local, fast, and works well enough as a first pass for webcam panels.
 */
export const analyzeSpeakerFocus: SpeakerFocusAnalyzer = async (
  input,
  startSec,
  endSec,
  panels,
  opts,
) => {
  const durationSec = Math.max(0.1, endSec - startSec);
  const fullOpts: Required<SpeakerAnalysisOptions> = {
    ffmpeg: opts.ffmpeg,
    fps: opts.fps ?? 4,
    width: opts.width ?? 96,
  };
  const motion = await Promise.all(
    panels.map((panel) => panelMotion(input, startSec, durationSec, panel, fullOpts)),
  );
  const frames = Math.min(...motion.map((m) => m.length));
  if (!Number.isFinite(frames) || frames <= 0) {
    return [{ startSec: 0, endSec: durationSec, panel: 0 }];
  }

  const raw: SpeakerFocusSegment[] = [];
  let current = 0;
  let currentStart = 0;
  const threshold = 2.5;
  for (let frame = 0; frame < frames; frame++) {
    let best = current;
    let bestScore = motion[current]?.[frame] ?? 0;
    for (let panel = 0; panel < motion.length; panel++) {
      const score = motion[panel]?.[frame] ?? 0;
      if (score > bestScore + threshold) {
        best = panel;
        bestScore = score;
      }
    }
    const t = Math.min(durationSec, (frame + 1) / fullOpts.fps);
    if (best !== current) {
      raw.push({ startSec: currentStart, endSec: frame / fullOpts.fps, panel: current });
      current = best;
      currentStart = frame / fullOpts.fps;
    }
    if (frame === frames - 1) {
      raw.push({ startSec: currentStart, endSec: t, panel: current });
    }
  }
  return mergeSegments(raw, 1.25);
};
