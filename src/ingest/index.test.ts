import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import {
  buildDownloadArgs,
  inferPlatform,
  parseDownloadOutput,
  sourceIdFromUrl,
  YtDlpDownloader,
} from './index.js';

describe('inferPlatform', () => {
  it('maps known hosts', () => {
    expect(inferPlatform('https://www.twitch.tv/foo/videos/123')).toBe('twitch');
    expect(inferPlatform('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(inferPlatform('https://youtu.be/abc')).toBe('youtube');
    expect(inferPlatform('https://kick.com/foo')).toBe('kick');
  });

  it('falls back to other for unknown or invalid urls', () => {
    expect(inferPlatform('https://example.com/x')).toBe('other');
    expect(inferPlatform('not a url')).toBe('other');
  });
});

describe('sourceIdFromUrl', () => {
  it('is stable and short', () => {
    const a = sourceIdFromUrl('https://twitch.tv/x');
    expect(a).toHaveLength(12);
    expect(sourceIdFromUrl('https://twitch.tv/x')).toBe(a);
    expect(sourceIdFromUrl('https://twitch.tv/y')).not.toBe(a);
  });
});

describe('buildDownloadArgs', () => {
  it('encodes the height cap, output template and print template', () => {
    const args = buildDownloadArgs('https://twitch.tv/x', '/out', 720);
    expect(args).toContain('bestvideo[height<=720]+bestaudio/best[height<=720]/best');
    const oIdx = args.indexOf('-o');
    expect(args[oIdx + 1]).toContain('%(id)s.%(ext)s');
    expect(args).toContain('--no-simulate');
    expect(args.some((a) => a.startsWith('after_move:'))).toBe(true);
    expect(args[args.length - 1]).toBe('https://twitch.tv/x');
  });
});

describe('parseDownloadOutput', () => {
  it('parses the last tab-separated line', () => {
    const out = 'noise line\nvid42\tBig Moment\t7200.5\t/data/downloads/vid42.mp4\n';
    expect(parseDownloadOutput(out)).toEqual({
      ytId: 'vid42',
      title: 'Big Moment',
      durationSec: 7200.5,
      filepath: '/data/downloads/vid42.mp4',
    });
  });

  it('defaults duration to 0 when not numeric (e.g. live NA)', () => {
    expect(parseDownloadOutput('id\tt\tNA\t/p.mp4').durationSec).toBe(0);
  });

  it('throws on empty or malformed output', () => {
    expect(() => parseDownloadOutput('   ')).toThrow(/no output/);
    expect(() => parseDownloadOutput('too\tfew')).toThrow(/Unexpected/);
  });
});

describe('YtDlpDownloader', () => {
  it('runs yt-dlp and returns a SourceVideo', async () => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        stdout: 'vid42\tEpic Fail\t120\t/out/vid42.mp4',
        stderr: '',
        exitCode: 0,
      }),
    };
    const dl = new YtDlpDownloader({
      runner,
      binary: 'yt-dlp',
      outDir: '/out',
      defaultMaxHeight: 1080,
    });
    const source = await dl.download('https://www.youtube.com/watch?v=abc');

    expect(runner.run).toHaveBeenCalledOnce();
    const [bin, args] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe('yt-dlp');
    expect(args).toContain('bestvideo[height<=1080]+bestaudio/best[height<=1080]/best');

    expect(source).toMatchObject({
      url: 'https://www.youtube.com/watch?v=abc',
      platform: 'youtube',
      title: 'Epic Fail',
      durationSec: 120,
      localPath: '/out/vid42.mp4',
    });
    expect(source.id).toHaveLength(12);
    expect(source.downloadedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
