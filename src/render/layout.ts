/**
 * Reframing layouts: how a wide source becomes a 1080x1920 vertical clip.
 *
 * `fill` scales the whole frame up and takes a 9:16 slice of it. That is right for normal
 * full-frame footage and wrong for a *screen recording*, where the frame is a browser
 * window: the slice is only 405px wide out of 1280, so it lands wherever the geometric
 * centre happens to be — for a side-by-side webcam layout that is the divider between the
 * two panels, giving half of each face plus the URL bar and the taskbar.
 *
 * `stack` fixes that by treating the source as a composition rather than a picture: crop
 * the panels that matter out of it, scale each to full width, and stack them vertically.
 * Both faces are visible, all browser/OS chrome is gone, and the leftover height at the
 * bottom becomes a dedicated caption bar instead of text sitting over someone's chin.
 */

/** Output frame size for vertical short-form video. */
export const OUT_W = 1080;
export const OUT_H = 1920;

/** A rectangular region of the source frame, in source pixels. */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutMode = 'fill' | 'fit' | 'stack' | 'speaker' | 'auto';

/**
 * Parse an `x,y,w,h` rect. Returns undefined for anything malformed so callers can
 * report a useful configuration error rather than passing junk into a filtergraph.
 */
export function parseRect(raw: string): PanelRect | undefined {
  const parts = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (parts.length !== 4) return undefined;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return undefined;
  return { x, y, w, h };
}

/** Format a rect back to `x,y,w,h` (for logs and error messages). */
export function formatRect(r: PanelRect): string {
  return `${r.x},${r.y},${r.w},${r.h}`;
}

/**
 * Height a panel takes once scaled to the full output width, rounded down to an even
 * number — H.264 chroma subsampling requires even dimensions.
 */
export function scaledPanelHeight(panel: PanelRect): number {
  return Math.floor((panel.h * OUT_W) / panel.w / 2) * 2;
}

/**
 * Total height of the stacked panels, and the leftover strip beneath them.
 * The strip is where the caption goes; it can be zero if the panels fill the frame.
 */
export function stackMetrics(panels: readonly PanelRect[]): {
  stackedH: number;
  stripH: number;
} {
  const stackedH = panels.reduce((acc, p) => acc + scaledPanelHeight(p), 0);
  return { stackedH, stripH: Math.max(0, OUT_H - stackedH) };
}

/**
 * ffmpeg crop x-offset expression for a horizontal focus (0=left … 1=right), used by the
 * `fill` layout. `in_w` is the scaled input width; keep a 1080-wide slice at that focus.
 */
export function cropXExpr(cropX: string): string {
  const named: Record<string, number> = { left: 0, center: 0.5, right: 1 };
  const frac = cropX in named ? named[cropX]! : Number.parseFloat(cropX);
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0.5;
  return `(in_w-${OUT_W})*${f}`;
}

/**
 * A built filtergraph. `vf` goes to `-vf` and lets ffmpeg map streams implicitly;
 * `complex` needs `-filter_complex` plus explicit `-map`, because it consumes the video
 * stream more than once.
 */
export type FilterSpec =
  | { kind: 'vf'; filter: string }
  | { kind: 'complex'; graph: string; videoLabel: string };

/** A time span, relative to the rendered clip start, focused on one source panel. */
export interface SpeakerFocusSegment {
  startSec: number;
  endSec: number;
  panel: number;
}

/** The `fill` chain: scale the whole frame up, then slice 9:16 out of it. */
export function fillChain(cropX: string): string[] {
  return [
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase`,
    `crop=${OUT_W}:${OUT_H}:${cropXExpr(cropX)}:0`,
  ];
}

function appendPostFilters(
  baseLabel: string,
  filters: readonly string[],
  steps: string[],
): FilterSpec {
  const chain = filters.filter((f) => f.trim().length > 0).join(',');
  if (chain.length > 0) {
    steps.push(`[${baseLabel}]${chain}[vout]`);
    return { kind: 'complex', graph: steps.join(';'), videoLabel: 'vout' };
  }
  return { kind: 'complex', graph: steps.join(';'), videoLabel: baseLabel };
}

/**
 * The `fit` graph: keep the whole source visible over a blurred 9:16 background.
 * This is right for already-vertical, square, or 3:4 clips where `fill` would crop faces.
 */
export function fitGraph(postFilters: string | readonly string[] = []): FilterSpec {
  const filters = typeof postFilters === 'string' ? [postFilters] : postFilters;
  const steps = [
    '[0:v]split=2[bgsrc][fgsrc]',
    `[bgsrc]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${OUT_W}:${OUT_H},boxblur=20:1[bg]`,
    `[fgsrc]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[padded]',
  ];
  return appendPostFilters('padded', filters, steps);
}

/**
 * The `stack` graph: split the video once per panel, crop and scale each to full width,
 * vstack them, then pad out to a full 1080x1920 so the caption strip exists even when the
 * panels don't reach the bottom.
 */
export function stackGraph(
  panels: readonly PanelRect[],
  postFilters: string | readonly string[] = [],
): FilterSpec {
  if (panels.length < 2) throw new Error('stack layout needs at least two panels');
  const n = panels.length;
  const splitLabels = panels.map((_, i) => `s${i}`);
  const panelLabels = panels.map((_, i) => `p${i}`);

  const steps: string[] = [`[0:v]split=${n}${splitLabels.map((l) => `[${l}]`).join('')}`];
  for (const [i, p] of panels.entries()) {
    // scale=W:-2 keeps the panel's aspect ratio and forces an even height.
    steps.push(
      `[${splitLabels[i]}]crop=${p.w}:${p.h}:${p.x}:${p.y},scale=${OUT_W}:-2[${panelLabels[i]}]`,
    );
  }
  steps.push(`${panelLabels.map((l) => `[${l}]`).join('')}vstack=inputs=${n}[stacked]`);
  // Panels sit at the top; the remainder is the caption bar.
  steps.push(`[stacked]pad=${OUT_W}:${OUT_H}:0:0:black[padded]`);

  const filters = typeof postFilters === 'string' ? [postFilters] : postFilters;
  return appendPostFilters('padded', filters, steps);
}

/**
 * Dynamic speaker-focus graph: split a clip into time ranges, crop the active panel for
 * each range, scale it to 9:16, then concatenate the ranges back into one video stream.
 *
 * Detection lives outside this file; this function only turns a panel/time plan into a
 * deterministic ffmpeg graph.
 */
export function speakerGraph(
  panels: readonly PanelRect[],
  focus: readonly SpeakerFocusSegment[],
  postFilters: string | readonly string[] = [],
): FilterSpec {
  if (panels.length < 2) throw new Error('speaker layout needs at least two panels');
  const usable = focus.filter((s) => s.endSec > s.startSec && panels[s.panel]);
  const segments =
    usable.length > 0
      ? usable
      : [{ startSec: 0, endSec: 999999, panel: 0 } satisfies SpeakerFocusSegment];

  const steps: string[] = [];
  const labels: string[] = [];
  for (const [i, seg] of segments.entries()) {
    const p = panels[seg.panel] ?? panels[0]!;
    const label = `sp${i}`;
    labels.push(label);
    steps.push(
      `[0:v]trim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},` +
        `setpts=PTS-STARTPTS,` +
        `crop=${p.w}:${p.h}:${p.x}:${p.y},` +
        `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
        `crop=${OUT_W}:${OUT_H}[${label}]`,
    );
  }

  let baseLabel: string;
  if (labels.length === 1) {
    baseLabel = labels[0]!;
  } else {
    baseLabel = 'focused';
    steps.push(
      `${labels.map((label) => `[${label}]`).join('')}concat=n=${labels.length}:v=1:a=0[${baseLabel}]`,
    );
  }

  const filters = typeof postFilters === 'string' ? [postFilters] : postFilters;
  return appendPostFilters(baseLabel, filters, steps);
}
