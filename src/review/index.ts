/**
 * Local clip QA: generate contact sheets and machine-readable checks for rendered clips.
 *
 * This is deliberately objective. It does not try to decide if a joke is funny; it checks
 * things that break a batch mechanically: wrong aspect ratio, missing audio, bad duration,
 * failed render, or missing subtitle sidecar. The contact sheet is the fast human/agent
 * review artifact for visual judgement.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { getConfig } from '../config/index.js';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { ffmpegBinary } from '../core/platform.js';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm']);

export interface ClipProbe {
  path: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface ClipQaIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
}

export interface ClipQaReport {
  clip: ClipProbe;
  passed: boolean;
  issues: ClipQaIssue[];
  contactSheetPath: string;
  reportPath: string;
  subtitleSidecarPath?: string;
}

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format?: { duration?: string };
}

export interface QaOptions {
  runner?: CommandRunner;
  ffmpeg?: string;
  ffprobe?: string;
  outDir?: string;
  minSec?: number;
  maxSec?: number;
  expectedWidth?: number;
  expectedHeight?: number;
  frames?: number;
}

export function ffprobeBinaryFor(ffmpeg: string): string {
  const name = basename(ffmpeg);
  if (name.toLowerCase().startsWith('ffmpeg')) {
    const suffix = name.slice('ffmpeg'.length);
    const probe = `ffprobe${suffix}`;
    return dirname(ffmpeg) === '.' ? probe : join(dirname(ffmpeg), probe);
  }
  return 'ffprobe';
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXTS.has(extname(path).toLowerCase());
}

export async function discoverClipFiles(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return isVideoPath(target) ? [target] : [];
  if (!info.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(target, e.name))
    .filter(isVideoPath)
    .sort((a, b) => a.localeCompare(b));
}

export function buildProbeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    input,
  ];
}

export function parseProbe(path: string, raw: string): ClipProbe {
  const parsed = JSON.parse(raw) as FfprobeJson;
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  const audio = parsed.streams?.some((s) => s.codec_type === 'audio') ?? false;
  const duration = Number.parseFloat(video?.duration ?? parsed.format?.duration ?? '');
  return {
    path,
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: audio,
  };
}

export function buildContactSheetArgs(
  input: string,
  durationSec: number,
  frames: number,
  output: string,
): string[] {
  const safeFrames = Math.max(1, frames);
  const fps = Math.max(safeFrames / Math.max(durationSec, 1), 0.01);
  const cols = 4;
  const rows = Math.ceil(safeFrames / cols);
  return [
    '-y',
    '-i',
    input,
    '-vf',
    `fps=${fps.toFixed(4)},scale=270:-1,tile=${cols}x${rows}`,
    '-frames:v',
    '1',
    output,
  ];
}

export function evaluateClip(
  clip: ClipProbe,
  opts: Required<Pick<QaOptions, 'minSec' | 'maxSec' | 'expectedWidth' | 'expectedHeight'>>,
  subtitleSidecarExists: boolean,
): ClipQaIssue[] {
  const issues: ClipQaIssue[] = [];
  if (clip.width !== opts.expectedWidth || clip.height !== opts.expectedHeight) {
    issues.push({
      severity: 'error',
      code: 'aspect',
      message: `Expected ${opts.expectedWidth}x${opts.expectedHeight}, got ${clip.width}x${clip.height}`,
    });
  }
  if (!clip.hasAudio) {
    issues.push({ severity: 'error', code: 'audio', message: 'No audio stream found' });
  }
  if (clip.durationSec < opts.minSec || clip.durationSec > opts.maxSec) {
    issues.push({
      severity: 'warn',
      code: 'duration',
      message: `Duration ${clip.durationSec.toFixed(1)}s is outside ${opts.minSec}-${opts.maxSec}s`,
    });
  }
  if (!subtitleSidecarExists) {
    issues.push({
      severity: 'warn',
      code: 'subtitles',
      message: 'No .subtitles.ass sidecar found; synced captions may not have been generated',
    });
  }
  return issues;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function qaClip(path: string, opts: QaOptions = {}): Promise<ClipQaReport> {
  const cfg = getConfig();
  const runner = opts.runner ?? execaRunner;
  const ffmpeg = opts.ffmpeg ?? ffmpegBinary();
  const ffprobe = opts.ffprobe ?? ffprobeBinaryFor(ffmpeg);
  const outDir = opts.outDir ?? join(dirname(path), 'qa');
  const minSec = opts.minSec ?? cfg.clip.minSec;
  const maxSec = opts.maxSec ?? cfg.clip.maxSec;
  const expectedWidth = opts.expectedWidth ?? 1080;
  const expectedHeight = opts.expectedHeight ?? 1920;
  const frames = opts.frames ?? 12;
  await mkdir(outDir, { recursive: true });

  const { stdout } = await runner.run(ffprobe, buildProbeArgs(path));
  const clip = parseProbe(path, stdout);
  const base = basename(path, extname(path));
  const contactSheetPath = join(outDir, `${base}.contact.jpg`);
  const reportPath = join(outDir, `${base}.qa.json`);
  const subtitleSidecarPath = join(dirname(path), `${base}.subtitles.ass`);
  const subtitleSidecarExists = await fileExists(subtitleSidecarPath);

  await runner.run(ffmpeg, buildContactSheetArgs(path, clip.durationSec, frames, contactSheetPath));
  const issues = evaluateClip(
    clip,
    { minSec, maxSec, expectedWidth, expectedHeight },
    subtitleSidecarExists,
  );
  const report: ClipQaReport = {
    clip,
    passed: issues.length === 0,
    issues,
    contactSheetPath,
    reportPath,
    ...(subtitleSidecarExists ? { subtitleSidecarPath } : {}),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function qaTarget(target: string, opts: QaOptions = {}): Promise<ClipQaReport[]> {
  const files = await discoverClipFiles(target);
  const reports: ClipQaReport[] = [];
  for (const file of files) reports.push(await qaClip(file, opts));
  return reports;
}
