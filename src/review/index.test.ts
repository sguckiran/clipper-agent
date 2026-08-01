import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import {
  buildContactSheetArgs,
  buildProbeArgs,
  discoverClipFiles,
  evaluateClip,
  ffprobeBinaryFor,
  isVideoPath,
  parseProbe,
  qaClip,
} from './index.js';

describe('ffprobeBinaryFor', () => {
  it('derives ffprobe from a concrete ffmpeg path', () => {
    expect(ffprobeBinaryFor('C:\\ffmpeg\\bin\\ffmpeg.exe')).toBe('C:\\ffmpeg\\bin\\ffprobe.exe');
  });

  it('falls back to ffprobe for non-ffmpeg binary names', () => {
    expect(ffprobeBinaryFor('avconv')).toBe('ffprobe');
  });
});

describe('isVideoPath / discoverClipFiles', () => {
  it('detects supported video extensions case-insensitively', () => {
    expect(isVideoPath('clip.MP4')).toBe(true);
    expect(isVideoPath('clip.txt')).toBe(false);
  });

  it('discovers direct child clips in a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clipper-qa-'));
    await writeFile(join(dir, 'a.mp4'), '');
    await writeFile(join(dir, 'b.txt'), '');
    await writeFile(join(dir, 'c.webm'), '');
    expect((await discoverClipFiles(dir)).map((p) => p.split(/[\\/]/).pop())).toEqual([
      'a.mp4',
      'c.webm',
    ]);
  });
});

describe('probe/contact sheet args', () => {
  it('builds ffprobe json args', () => {
    expect(buildProbeArgs('/clips/a.mp4')).toEqual([
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height,duration',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      '/clips/a.mp4',
    ]);
  });

  it('builds a tiled contact sheet filter', () => {
    const args = buildContactSheetArgs('/clips/a.mp4', 24, 12, '/qa/a.jpg');
    expect(args).toContain('/clips/a.mp4');
    expect(args).toContain('fps=0.5000,scale=270:-1,tile=4x3');
    expect(args[args.length - 1]).toBe('/qa/a.jpg');
  });
});

describe('parseProbe / evaluateClip', () => {
  it('parses ffprobe output into a compact clip probe', () => {
    const probe = parseProbe(
      '/clips/a.mp4',
      JSON.stringify({
        streams: [
          { codec_type: 'video', width: 1080, height: 1920 },
          { codec_type: 'audio' },
        ],
        format: { duration: '30.5' },
      }),
    );
    expect(probe).toEqual({
      path: '/clips/a.mp4',
      durationSec: 30.5,
      width: 1080,
      height: 1920,
      hasAudio: true,
    });
  });

  it('flags broken aspect ratio, missing audio, duration and missing subtitles', () => {
    const issues = evaluateClip(
      { path: 'x', durationSec: 5, width: 720, height: 1280, hasAudio: false },
      { minSec: 15, maxSec: 60, expectedWidth: 1080, expectedHeight: 1920 },
      false,
    );
    expect(issues.map((i) => i.code)).toEqual(['aspect', 'audio', 'duration', 'subtitles']);
    expect(issues.filter((i) => i.severity === 'error').map((i) => i.code)).toEqual([
      'aspect',
      'audio',
    ]);
  });
});

describe('qaClip', () => {
  it('writes a report and generates a contact sheet through injected binaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clipper-qa-'));
    const clip = join(dir, 'clip.mp4');
    await writeFile(clip, '');
    await writeFile(join(dir, 'clip.subtitles.ass'), '');
    const runner: CommandRunner = {
      run: vi.fn(async (file: string) => {
        if (file === 'ffprobe') {
          return {
            stdout: JSON.stringify({
              streams: [
                { codec_type: 'video', width: 1080, height: 1920 },
                { codec_type: 'audio' },
              ],
              format: { duration: '30' },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };

    const report = await qaClip(clip, {
      runner,
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      outDir: join(dir, 'qa'),
      minSec: 15,
      maxSec: 60,
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.contactSheetPath).toMatch(/clip\.contact\.jpg$/);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});
