/**
 * Render module: cuts a candidate window, reframes it to vertical 9:16 and burns
 * the caption with ffmpeg. Implements the {@link Renderer} contract. The encoder is
 * chosen per-platform (VideoToolbox on Apple Silicon, libx264 elsewhere) and the
 * subprocess runner is injected so tests assert the ffmpeg command without rendering.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '../config/index.js';
import type { Renderer } from '../core/contracts.js';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { ensureDataDirs } from '../core/paths.js';
import { defaultCaptionFontFile, ffmpegBinary, preferredH264Encoder } from '../core/platform.js';
import type { Caption, Clip, ClipCandidate, SourceVideo } from '../core/types.js';

export { createCaptionWriter, LlmCaptionWriter } from './caption.js';

/** Output frame size for vertical short-form video. */
const OUT_W = 1080;
const OUT_H = 1920;

/**
 * Escape a file path for a drawtext `fontfile=`/`textfile=` value: forward slashes,
 * and the Windows drive-letter colon escaped (e.g. `C\:/Windows/Fonts/arial.ttf`).
 * The value must still be wrapped in single quotes by the caller.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
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

/**
 * Build the ffmpeg `-vf` filtergraph: reframe to 9:16, then burn the caption.
 *
 * Both the font and the caption text are passed to drawtext as files (`fontfile=` +
 * `textfile=`) so rendering never depends on fontconfig, and arbitrary caption text
 * (commas, apostrophes, colons, `%`) can't break the filtergraph parser.
 * `expansion=none` keeps the caption fully literal.
 */
export function buildVideoFilter(caption: Caption, fontFile: string, textFile: string): string {
  const parts = [
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase`,
    `crop=${OUT_W}:${OUT_H}`,
  ];
  if (caption.text.trim().length > 0) {
    const style = caption.style ?? {};
    const fontsize = style.fontSizePx ?? 48;
    const color = style.color ?? 'white';
    const y = captionY(style.position);
    parts.push(
      `drawtext=fontfile='${escapeFilterPath(fontFile)}'` +
        `:textfile='${escapeFilterPath(textFile)}'` +
        `:expansion=none` +
        `:fontcolor=${color}:fontsize=${fontsize}` +
        `:box=1:boxcolor=black@0.5:boxborderw=12` +
        `:x=(w-text_w)/2:y=${y}`,
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
  /** Explicit caption font file; falls back to config, then a per-OS default. */
  fontFile?: string;
  /** Fixed output directory; falls back to the data clips dir. */
  outDir?: string;
}

export class FfmpegRenderer implements Renderer {
  private readonly runner: CommandRunner;
  private readonly ffmpeg: string;
  private readonly encoder: string;
  private readonly fontFile: string;
  private readonly outDirOverride?: string;
  private readonly log = createLogger('render');

  constructor(opts: RendererOptions = {}) {
    this.runner = opts.runner ?? execaRunner;
    this.ffmpeg = opts.ffmpeg ?? ffmpegBinary();
    this.encoder = opts.encoder ?? preferredH264Encoder();
    this.fontFile = opts.fontFile ?? getConfig().render.captionFont ?? defaultCaptionFontFile();
    this.outDirOverride = opts.outDir;
  }

  async render(source: SourceVideo, candidate: ClipCandidate, caption: Caption): Promise<Clip> {
    const outDir = this.outDirOverride ?? (await ensureDataDirs()).clips;
    const output = join(outDir, `${candidate.id}.mp4`);
    // Write the caption to a sidecar file so drawtext reads it via textfile= and the
    // filtergraph never has to parse arbitrary caption text.
    const captionFile = join(outDir, `${candidate.id}.caption.txt`);
    if (caption.text.trim().length > 0) {
      await writeFile(captionFile, caption.text.trim(), 'utf8');
    }
    const filter = buildVideoFilter(caption, this.fontFile, captionFile);
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
