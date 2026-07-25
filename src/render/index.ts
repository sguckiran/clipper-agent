/**
 * Render module: cuts a candidate window, reframes it to vertical 9:16 and burns
 * the caption with ffmpeg. Implements the {@link Renderer} contract. The encoder is
 * chosen per-platform (VideoToolbox on Apple Silicon, libx264 elsewhere) and the
 * subprocess runner is injected so tests assert the ffmpeg command without rendering.
 */
import { join } from 'node:path';
import type { Renderer } from '../core/contracts.js';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { ensureDataDirs } from '../core/paths.js';
import { ffmpegBinary, preferredH264Encoder } from '../core/platform.js';
import type { Caption, Clip, ClipCandidate, SourceVideo } from '../core/types.js';

export { createCaptionWriter, LlmCaptionWriter } from './caption.js';

/** Output frame size for vertical short-form video. */
const OUT_W = 1080;
const OUT_H = 1920;

/** Escape a caption for use inside a single-quoted ffmpeg drawtext value. */
export function escapeDrawText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '\\%');
}

function captionY(position: NonNullable<Caption['style']>['position']): string {
  switch (position) {
    case 'top':
      return 'text_h';
    case 'center':
      return '(h-text_h)/2';
    case 'bottom':
    default:
      return 'h-text_h*3';
  }
}

/** Build the ffmpeg `-vf` filtergraph: reframe to 9:16, then burn the caption. */
export function buildVideoFilter(caption: Caption): string {
  const parts = [
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase`,
    `crop=${OUT_W}:${OUT_H}`,
  ];
  const text = caption.text.trim();
  if (text.length > 0) {
    const style = caption.style ?? {};
    const fontsize = style.fontSizePx ?? 48;
    const color = style.color ?? 'white';
    const y = captionY(style.position);
    const font = style.fontFamily ? `:font='${style.fontFamily}'` : '';
    parts.push(
      `drawtext=text='${escapeDrawText(text)}'` +
        `:fontcolor=${color}:fontsize=${fontsize}` +
        `:box=1:boxcolor=black@0.5:boxborderw=12` +
        `:x=(w-text_w)/2:y=${y}${font}`,
    );
  }
  return parts.join(',');
}

/** Build the full ffmpeg argv to render one clip. */
export function buildRenderArgs(
  input: string,
  startSec: number,
  endSec: number,
  filter: string,
  encoder: string,
  output: string,
): string[] {
  const duration = Math.max(0, endSec - startSec);
  return [
    '-y',
    '-ss',
    startSec.toString(),
    '-i',
    input,
    '-t',
    duration.toString(),
    '-vf',
    filter,
    '-c:v',
    encoder,
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    output,
  ];
}

export interface RendererOptions {
  runner?: CommandRunner;
  ffmpeg?: string;
  encoder?: string;
  /** Fixed output directory; falls back to the data clips dir. */
  outDir?: string;
}

export class FfmpegRenderer implements Renderer {
  private readonly runner: CommandRunner;
  private readonly ffmpeg: string;
  private readonly encoder: string;
  private readonly outDirOverride?: string;
  private readonly log = createLogger('render');

  constructor(opts: RendererOptions = {}) {
    this.runner = opts.runner ?? execaRunner;
    this.ffmpeg = opts.ffmpeg ?? ffmpegBinary();
    this.encoder = opts.encoder ?? preferredH264Encoder();
    this.outDirOverride = opts.outDir;
  }

  async render(source: SourceVideo, candidate: ClipCandidate, caption: Caption): Promise<Clip> {
    const outDir = this.outDirOverride ?? (await ensureDataDirs()).clips;
    const output = join(outDir, `${candidate.id}.mp4`);
    const filter = buildVideoFilter(caption);
    const args = buildRenderArgs(
      source.localPath,
      candidate.startSec,
      candidate.endSec,
      filter,
      this.encoder,
      output,
    );
    this.log.info({ id: candidate.id, encoder: this.encoder }, 'rendering clip');
    await this.runner.run(this.ffmpeg, args);
    return {
      id: `clip-${candidate.id}`,
      candidateId: candidate.id,
      sourceId: candidate.sourceId,
      startSec: candidate.startSec,
      endSec: candidate.endSec,
      caption,
      renderedPath: output,
      status: 'rendered',
    };
  }
}

export function createRenderer(opts?: RendererOptions): Renderer {
  return new FfmpegRenderer(opts);
}
