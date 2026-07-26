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
import {
  fillChain,
  formatRect,
  stackGraph,
  stackMetrics,
  type FilterSpec,
  type LayoutMode,
  type PanelRect,
} from './layout.js';

export { createCaptionWriter, LlmCaptionWriter } from './caption.js';
export * from './layout.js';

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
 * Build the drawtext filter for a caption, or undefined when there is nothing to draw.
 *
 * Both the font and the caption text are passed as files (`fontfile=` + `textfile=`) so
 * rendering never depends on fontconfig, and arbitrary caption text (commas, apostrophes,
 * colons, `%`) can't break the filtergraph parser. `expansion=none` keeps it fully literal.
 */
export function drawtextFilter(
  caption: Caption,
  fontFile: string,
  textFile: string,
  yExpr?: string,
): string | undefined {
  if (caption.text.trim().length === 0) return undefined;
  const style = caption.style ?? {};
  const fontsize = style.fontSizePx ?? 48;
  const color = style.color ?? 'white';
  const y = yExpr ?? captionY(style.position);
  return (
    `drawtext=fontfile='${escapeFilterPath(fontFile)}'` +
    `:textfile='${escapeFilterPath(textFile)}'` +
    `:expansion=none` +
    `:fontcolor=${color}:fontsize=${fontsize}` +
    `:box=1:boxcolor=black@0.5:boxborderw=12` +
    `:x=(w-text_w)/2:y=${y}`
  );
}

/**
 * Centre the caption inside the strip left below the stacked panels. Falls back to the
 * normal bottom placement when the panels fill the whole frame and there is no strip.
 */
export function stackCaptionY(stackedH: number, stripH: number): string {
  if (stripH < 40) return 'h-text_h*3';
  return `${stackedH}+(${stripH}-text_h)/2`;
}

/**
 * Build the filtergraph for a clip: reframe per the chosen layout, then burn the caption.
 */
export function buildFilterSpec(
  caption: Caption,
  fontFile: string,
  textFile: string,
  layout: LayoutMode,
  cropX: string,
  panels: readonly PanelRect[],
): FilterSpec {
  if (layout === 'stack') {
    const { stackedH, stripH } = stackMetrics(panels);
    return stackGraph(
      panels,
      drawtextFilter(caption, fontFile, textFile, stackCaptionY(stackedH, stripH)),
    );
  }
  const parts = fillChain(cropX);
  const draw = drawtextFilter(caption, fontFile, textFile);
  if (draw) parts.push(draw);
  return { kind: 'vf', filter: parts.join(',') };
}

/**
 * Build the full ffmpeg argv to render one clip.
 *
 * A `complex` graph consumes the video stream several times, so ffmpeg no longer picks
 * streams for us — the video comes from the graph's output label and the audio has to be
 * mapped explicitly. `0:a?` is optional so a source with no audio track still renders.
 */
export function buildRenderArgs(
  input: string,
  startSec: number,
  endSec: number,
  spec: FilterSpec,
  encoder: string,
  output: string,
): string[] {
  const duration = Math.max(0, endSec - startSec);
  const filterArgs =
    spec.kind === 'vf'
      ? ['-vf', spec.filter]
      : ['-filter_complex', spec.graph, '-map', `[${spec.videoLabel}]`, '-map', '0:a?'];
  return [
    '-y',
    '-ss',
    startSec.toString(),
    '-i',
    input,
    '-t',
    duration.toString(),
    ...filterArgs,
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
  /** Horizontal crop focus ('center'|'left'|'right'|0..1); falls back to config. */
  cropX?: string;
  /** Reframing layout; falls back to config. */
  layout?: LayoutMode;
  /** Source panels to stack, when layout is 'stack'; falls back to config. */
  panels?: readonly PanelRect[];
  /** Fixed output directory; falls back to the data clips dir. */
  outDir?: string;
}

export class FfmpegRenderer implements Renderer {
  private readonly runner: CommandRunner;
  private readonly ffmpeg: string;
  private readonly encoder: string;
  private readonly fontFile: string;
  private readonly cropX: string;
  private readonly layout: LayoutMode;
  private readonly panels: readonly PanelRect[];
  private readonly outDirOverride?: string;
  private readonly log = createLogger('render');

  constructor(opts: RendererOptions = {}) {
    const cfg = getConfig().render;
    this.runner = opts.runner ?? execaRunner;
    this.ffmpeg = opts.ffmpeg ?? ffmpegBinary();
    this.encoder = opts.encoder ?? preferredH264Encoder();
    this.fontFile = opts.fontFile ?? cfg.captionFont ?? defaultCaptionFontFile();
    this.cropX = opts.cropX ?? cfg.cropX;
    this.layout = opts.layout ?? cfg.layout;
    this.panels = opts.panels ?? cfg.panels;
    this.outDirOverride = opts.outDir;
    // Fail at construction, not mid-render: the factory builds the renderer before any
    // download starts, so a misconfigured layout surfaces in seconds rather than after
    // an hour of transcription.
    if (this.layout === 'stack' && this.panels.length < 2) {
      throw new Error(
        'CLIPPER_LAYOUT=stack needs at least two panels — set CLIPPER_PANELS to ' +
          'semicolon-separated "x,y,w,h" rects (e.g. "34,74,600,448;634,74,600,448")',
      );
    }
    if (this.layout === 'stack') {
      const { stackedH, stripH } = stackMetrics(this.panels);
      this.log.info(
        { panels: this.panels.map(formatRect), stackedH, captionStripH: stripH },
        'stack layout active',
      );
    }
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
    const spec = buildFilterSpec(
      caption,
      this.fontFile,
      captionFile,
      this.layout,
      this.cropX,
      this.panels,
    );
    const args = buildRenderArgs(
      source.localPath,
      candidate.startSec,
      candidate.endSec,
      spec,
      this.encoder,
      output,
    );
    this.log.info(
      { id: candidate.id, encoder: this.encoder, layout: this.layout },
      'rendering clip',
    );
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
