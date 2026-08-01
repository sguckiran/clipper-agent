import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import type { Caption, ClipCandidate, SourceVideo } from '../core/types.js';
import {
  buildFilterSpec,
  buildRenderArgs,
  cropXExpr,
  drawtextFilter,
  escapeFilterPath,
  FfmpegRenderer,
  formatRect,
  parseRect,
  scaledPanelHeight,
  stackCaptionY,
  stackGraph,
  stackMetrics,
  type PanelRect,
} from './index.js';

const FONT = '/fonts/DejaVuSans.ttf';
const TEXT = '/tmp/cap.txt';

/** The krimoe OmeTV layout: two 600x448 webcam panels side by side in a 1280x720 capture. */
const PANELS: PanelRect[] = [
  { x: 34, y: 74, w: 600, h: 448 },
  { x: 634, y: 74, w: 600, h: 448 },
];

const vf = (spec: ReturnType<typeof buildFilterSpec>): string =>
  spec.kind === 'vf' ? spec.filter : spec.graph;

describe('cropXExpr', () => {
  it('maps named + fractional focus to an x-offset expression', () => {
    expect(cropXExpr('center')).toBe('(in_w-1080)*0.5');
    expect(cropXExpr('left')).toBe('(in_w-1080)*0');
    expect(cropXExpr('right')).toBe('(in_w-1080)*1');
    expect(cropXExpr('0.25')).toBe('(in_w-1080)*0.25');
  });
  it('falls back to center for garbage', () => {
    expect(cropXExpr('nonsense')).toBe('(in_w-1080)*0.5');
  });
});

describe('escapeFilterPath', () => {
  it('forward-slashes and escapes the Windows drive colon', () => {
    expect(escapeFilterPath('C:\\Windows\\Fonts\\arial.ttf')).toBe('C\\:/Windows/Fonts/arial.ttf');
    expect(escapeFilterPath('/usr/share/fonts/x.ttf')).toBe('/usr/share/fonts/x.ttf');
  });
});

describe('parseRect / formatRect', () => {
  it('round-trips a valid rect', () => {
    expect(formatRect(parseRect(' 34, 74, 600, 448 ')!)).toBe('34,74,600,448');
  });

  it('rejects malformed rects', () => {
    for (const bad of ['', '1,2,3', '1,2,3,4,5', 'a,b,c,d', '0,0,0,100', '0,0,100,-5']) {
      expect(parseRect(bad)).toBeUndefined();
    }
  });
});

describe('scaledPanelHeight / stackMetrics', () => {
  it('scales a panel to full width with an even height', () => {
    // 448 * 1080/600 = 806.4 -> 806 (even; H.264 requires even dimensions)
    expect(scaledPanelHeight(PANELS[0]!)).toBe(806);
  });

  it('reports the stacked height and the leftover caption strip', () => {
    expect(stackMetrics(PANELS)).toEqual({ stackedH: 1612, stripH: 308 });
  });

  it('reports no strip when the panels fill the frame', () => {
    // two 1080x960 panels stack to exactly 1920 — no room left for a caption bar
    const full: PanelRect[] = [
      { x: 0, y: 0, w: 1080, h: 960 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ];
    expect(stackMetrics(full)).toEqual({ stackedH: 1920, stripH: 0 });
  });

  it('never reports a negative strip when the panels overflow', () => {
    const tall: PanelRect[] = [
      { x: 0, y: 0, w: 600, h: 800 },
      { x: 0, y: 0, w: 600, h: 800 },
    ];
    expect(stackMetrics(tall).stripH).toBe(0);
  });
});

describe('stackCaptionY', () => {
  it('centres the caption in the leftover strip', () => {
    expect(stackCaptionY(1612, 308)).toBe('1612+(308-text_h)/2');
  });

  it('falls back to bottom placement when there is no usable strip', () => {
    expect(stackCaptionY(1900, 20)).toBe('h-text_h*3');
  });
});

describe('stackGraph', () => {
  it('splits, crops each panel, scales to width and vstacks', () => {
    const spec = stackGraph(PANELS);
    expect(spec.kind).toBe('complex');
    const g = vf(spec);
    expect(g).toContain('[0:v]split=2[s0][s1]');
    expect(g).toContain('[s0]crop=600:448:34:74,scale=1080:-2[p0]');
    expect(g).toContain('[s1]crop=600:448:634:74,scale=1080:-2[p1]');
    expect(g).toContain('[p0][p1]vstack=inputs=2[stacked]');
    expect(g).toContain('[stacked]pad=1080:1920:0:0:black[padded]');
  });

  it('appends drawtext and exposes it as the output label', () => {
    const spec = stackGraph(PANELS, 'drawtext=foo');
    expect(spec).toMatchObject({ kind: 'complex', videoLabel: 'vout' });
    expect(vf(spec)).toContain('[padded]drawtext=foo[vout]');
  });

  it('uses the padded label when there is no caption', () => {
    expect(stackGraph(PANELS)).toMatchObject({ videoLabel: 'padded' });
  });

  it('refuses fewer than two panels', () => {
    expect(() => stackGraph([PANELS[0]!])).toThrow(/at least two panels/);
  });
});

describe('drawtextFilter', () => {
  it('burns the caption via fontfile + textfile', () => {
    const filter = drawtextFilter({ text: 'WOW' }, FONT, TEXT)!;
    expect(filter).toContain("drawtext=fontfile='/fonts/DejaVuSans.ttf'");
    expect(filter).toContain("textfile='/tmp/cap.txt'");
    expect(filter).toContain('expansion=none');
    // caption text itself is never inlined into the filtergraph
    expect(filter).not.toContain('WOW');
  });

  it('returns undefined for an empty caption', () => {
    expect(drawtextFilter({ text: '   ' }, FONT, TEXT)).toBeUndefined();
  });

  it('honours style overrides', () => {
    const caption: Caption = {
      text: 'hi',
      style: { fontSizePx: 72, color: 'yellow', position: 'top' },
    };
    const filter = drawtextFilter(caption, FONT, TEXT)!;
    expect(filter).toContain('fontsize=72');
    expect(filter).toContain('fontcolor=yellow');
    expect(filter).toContain('y=text_h');
  });

  it('takes an explicit y expression', () => {
    expect(drawtextFilter({ text: 'hi' }, FONT, TEXT, '1612+(308-text_h)/2')).toContain(
      'y=1612+(308-text_h)/2',
    );
  });
});

describe('buildFilterSpec', () => {
  it('fill layout scales the whole frame then slices 9:16', () => {
    const spec = buildFilterSpec({ text: 'WOW' }, FONT, TEXT, 'fill', 'center', []);
    expect(spec.kind).toBe('vf');
    expect(vf(spec)).toContain('scale=1080:1920:force_original_aspect_ratio=increase');
    expect(vf(spec)).toContain('crop=1080:1920');
    expect(vf(spec)).toContain('drawtext');
  });

  it('moves the static hook to the top when synced subtitles are burned', () => {
    const spec = buildFilterSpec(
      { text: 'WOW' },
      FONT,
      TEXT,
      'fill',
      'center',
      [],
      '/tmp/subtitles.ass',
    );
    expect(vf(spec)).toContain('subtitles=filename=');
    expect(vf(spec)).toContain('fontsize=54');
    expect(vf(spec)).toContain('y=text_h');
  });

  it('stack layout crops panels and puts the caption in the strip', () => {
    const spec = buildFilterSpec({ text: 'WOW' }, FONT, TEXT, 'stack', 'center', PANELS);
    expect(spec.kind).toBe('complex');
    expect(vf(spec)).toContain('crop=600:448:34:74');
    expect(vf(spec)).toContain('vstack=inputs=2');
    expect(vf(spec)).toContain('y=1612+(308-text_h)/2');
    // never falls back to slicing the middle of the frame, which is the divider
    expect(vf(spec)).not.toContain('force_original_aspect_ratio=increase');
  });
});

describe('buildRenderArgs', () => {
  it('seeks, trims to duration and sets the encoder', () => {
    const args = buildRenderArgs(
      '/in.mp4',
      30,
      45,
      { kind: 'vf', filter: 'vf' },
      'libx264',
      '/out.mp4',
    );
    expect(args).toEqual([
      '-y',
      '-ss',
      '30',
      '-i',
      '/in.mp4',
      '-t',
      '15',
      '-vf',
      'vf',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '/out.mp4',
    ]);
  });

  it('maps streams explicitly for a complex graph', () => {
    // filter_complex consumes 0:v more than once, so ffmpeg stops auto-selecting streams.
    const args = buildRenderArgs(
      '/in.mp4',
      0,
      10,
      { kind: 'complex', graph: 'G', videoLabel: 'vout' },
      'libx264',
      '/out.mp4',
    );
    expect(args).toContain('-filter_complex');
    expect(args).toContain('G');
    expect(args.join(' ')).toContain('-map [vout] -map 0:a?');
    expect(args).not.toContain('-vf');
  });
});

describe('FfmpegRenderer', () => {
  const source: SourceVideo = {
    id: 'src',
    url: 'https://twitch.tv/x',
    platform: 'twitch',
    title: 't',
    durationSec: 100,
    localPath: '/dl/src.mp4',
    downloadedAt: '2026-01-01T00:00:00.000Z',
  };
  const candidate: ClipCandidate = {
    id: 'src-30.0',
    sourceId: 'src',
    startSec: 30,
    endSec: 45,
    score: 80,
    reason: 'hype',
    transcriptText: 'lets go',
  };
  const fakeRunner = (): CommandRunner => ({
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  });

  it('writes the caption sidecar, renders a clip and returns metadata', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'clipper-clips-'));
    const runner = fakeRunner();
    const renderer = new FfmpegRenderer({
      runner,
      ffmpeg: 'ffmpeg',
      encoder: 'libx264',
      fontFile: FONT,
      outDir,
    });
    // caption with a comma + apostrophe would break inline drawtext parsing
    const clip = await renderer.render(source, candidate, { text: "Wow, it's wild" });

    expect(runner.run).toHaveBeenCalledOnce();
    const [bin, args] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe('ffmpeg');
    expect(args).toContain('/dl/src.mp4');
    expect(args[args.length - 1]).toBe(join(outDir, 'src-30.0.mp4'));

    // the caption is written verbatim to the sidecar file
    expect(await readFile(join(outDir, 'src-30.0.caption.txt'), 'utf8')).toBe("Wow, it's wild");

    expect(clip).toMatchObject({
      id: 'clip-src-30.0',
      candidateId: 'src-30.0',
      sourceId: 'src',
      status: 'rendered',
      renderedPath: join(outDir, 'src-30.0.mp4'),
    });
  });

  it('renders the stack layout with filter_complex and explicit maps', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'clipper-clips-'));
    const runner = fakeRunner();
    const renderer = new FfmpegRenderer({
      runner,
      ffmpeg: 'ffmpeg',
      encoder: 'libx264',
      fontFile: FONT,
      outDir,
      layout: 'stack',
      panels: PANELS,
    });
    await renderer.render(source, candidate, { text: 'Show me your dicks now' });

    const [, args] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const line = (args as string[]).join(' ');
    expect(line).toContain('-filter_complex');
    expect(line).toContain('vstack=inputs=2');
    expect(line).toContain('-map [vout] -map 0:a?');
    expect(line).not.toContain('-vf ');
  });

  it('throws at construction when stack is configured without panels', () => {
    // Fail fast: the factory builds the renderer before any download, so this surfaces in
    // seconds instead of after an hour of transcription.
    expect(
      () =>
        new FfmpegRenderer({
          runner: fakeRunner(),
          ffmpeg: 'ffmpeg',
          fontFile: FONT,
          layout: 'stack',
        }),
    ).toThrow(/at least two panels/);
  });
});
