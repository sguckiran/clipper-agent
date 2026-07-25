import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import type { Caption, ClipCandidate, SourceVideo } from '../core/types.js';
import {
  buildRenderArgs,
  buildVideoFilter,
  cropXExpr,
  escapeFilterPath,
  FfmpegRenderer,
} from './index.js';

const FONT = '/fonts/DejaVuSans.ttf';
const TEXT = '/tmp/cap.txt';

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

describe('buildVideoFilter', () => {
  it('reframes to vertical and burns the caption via fontfile + textfile', () => {
    const filter = buildVideoFilter({ text: 'WOW' }, FONT, TEXT);
    expect(filter).toContain('scale=1080:1920:force_original_aspect_ratio=increase');
    expect(filter).toContain('crop=1080:1920');
    expect(filter).toContain("drawtext=fontfile='/fonts/DejaVuSans.ttf'");
    expect(filter).toContain("textfile='/tmp/cap.txt'");
    expect(filter).toContain('expansion=none');
    // caption text itself is never inlined into the filtergraph
    expect(filter).not.toContain('WOW');
  });

  it('omits drawtext when the caption is empty', () => {
    expect(buildVideoFilter({ text: '   ' }, FONT, TEXT)).not.toContain('drawtext');
  });

  it('honours style overrides', () => {
    const caption: Caption = {
      text: 'hi',
      style: { fontSizePx: 72, color: 'yellow', position: 'top' },
    };
    const filter = buildVideoFilter(caption, FONT, TEXT);
    expect(filter).toContain('fontsize=72');
    expect(filter).toContain('fontcolor=yellow');
    expect(filter).toContain('y=text_h');
  });
});

describe('buildRenderArgs', () => {
  it('seeks, trims to duration and sets the encoder', () => {
    const args = buildRenderArgs('/in.mp4', 30, 45, 'vf', 'libx264', '/out.mp4');
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
});

describe('FfmpegRenderer', () => {
  it('writes the caption sidecar, renders a clip and returns metadata', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'clipper-clips-'));
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
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
});
