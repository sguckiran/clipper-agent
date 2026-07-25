import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import type { Caption, ClipCandidate, SourceVideo } from '../core/types.js';
import { buildRenderArgs, buildVideoFilter, escapeDrawText, FfmpegRenderer } from './index.js';

describe('escapeDrawText', () => {
  it('escapes backslashes, quotes and percent signs', () => {
    expect(escapeDrawText("it's 100% \\ done")).toBe("it\\'s 100\\% \\\\ done");
  });
});

describe('buildVideoFilter', () => {
  it('reframes to vertical and burns the caption', () => {
    const filter = buildVideoFilter({ text: 'WOW' });
    expect(filter).toContain('scale=1080:1920:force_original_aspect_ratio=increase');
    expect(filter).toContain('crop=1080:1920');
    expect(filter).toContain("drawtext=text='WOW'");
  });

  it('omits drawtext when the caption is empty', () => {
    expect(buildVideoFilter({ text: '   ' })).not.toContain('drawtext');
  });

  it('honours style overrides', () => {
    const caption: Caption = {
      text: 'hi',
      style: { fontSizePx: 72, color: 'yellow', position: 'top' },
    };
    const filter = buildVideoFilter(caption);
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
  it('renders a clip and returns rendered metadata', async () => {
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
      outDir: '/clips',
    });
    const clip = await renderer.render(source, candidate, { text: 'LETS GO' });

    expect(runner.run).toHaveBeenCalledOnce();
    const [bin, args] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe('ffmpeg');
    expect(args).toContain('/dl/src.mp4');
    expect(args).toContain('-c:v');
    expect(args[args.length - 1]).toBe(join('/clips', 'src-30.0.mp4'));

    expect(clip).toMatchObject({
      id: 'clip-src-30.0',
      candidateId: 'src-30.0',
      sourceId: 'src',
      startSec: 30,
      endSec: 45,
      status: 'rendered',
      renderedPath: join('/clips', 'src-30.0.mp4'),
    });
  });
});
