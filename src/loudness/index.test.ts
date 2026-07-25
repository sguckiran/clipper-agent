import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import type { SourceVideo } from '../core/types.js';
import { buildLoudnessArgs, FfmpegLoudnessAnalyzer, median, parseEbur128 } from './index.js';

const FIXTURE = [
  '[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS    M: -30.0 S:-120.7  I: -70.1 LUFS  LRA: 0.0 LU  FTPK: -25.0 -26.0 dBFS  TPK: -25.0 -26.0 dBFS',
  '[Parsed_ebur128_0 @ 0x1] t: 0.2  TARGET:-23 LUFS    M: -10.0 S:-30.0   I: -40.0 LUFS  LRA: 0.0 LU  FTPK: -5.0 -6.0 dBFS   TPK: -5.0 -6.0 dBFS',
  '[Parsed_ebur128_0 @ 0x1] t: 0.3  TARGET:-23 LUFS    M: -inf  S:-120.7  I: -70.1 LUFS  LRA: 0.0 LU  FTPK: -inf -inf dBFS   TPK: -inf -inf dBFS',
  'not a loudness line',
].join('\n');

describe('buildLoudnessArgs', () => {
  it('uses ebur128 with peak and a null sink', () => {
    const args = buildLoudnessArgs('/in.mp4');
    expect(args).toContain('ebur128=peak=true');
    expect(args).toContain('-vn'); // audio-only, no video decode
    expect(args.indexOf('-vn')).toBeLessThan(args.indexOf('-i')); // input-level = skip demux
    expect(args).toContain('-i');
    expect(args).toContain('/in.mp4');
    expect(args.slice(-2)).toEqual(['null', '-']);
  });
});

describe('parseEbur128', () => {
  it('extracts one sample per interval and floors -inf', () => {
    const samples = parseEbur128(FIXTURE);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({ start: 0.1, end: 0.2, rms: -30, peak: -25 });
    expect(samples[1]).toMatchObject({ start: 0.2, rms: -10, peak: -5 });
    expect(samples[2]?.rms).toBe(-120);
    expect(samples[2]?.peak).toBe(-120);
  });

  it('takes the louder of the two FTPK channels for peak', () => {
    expect(parseEbur128(FIXTURE)[1]?.peak).toBe(-5);
  });
});

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    expect(median([-120, -30, -10])).toBe(-30);
    expect(median([-40, -20])).toBe(-30);
    expect(median([])).toBe(0);
  });
});

describe('FfmpegLoudnessAnalyzer', () => {
  it('runs ffmpeg and builds a timeline with a median baseline', async () => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: FIXTURE, exitCode: 0 }),
    };
    const source: SourceVideo = {
      id: 'abc',
      url: 'https://twitch.tv/x',
      platform: 'twitch',
      title: 't',
      durationSec: 100,
      localPath: '/dl/abc.mp4',
      downloadedAt: '2026-01-01T00:00:00.000Z',
    };
    const analyzer = new FfmpegLoudnessAnalyzer({ runner, ffmpeg: 'ffmpeg' });
    const timeline = await analyzer.analyze(source);

    expect(runner.run).toHaveBeenCalledOnce();
    expect(timeline.sourceId).toBe('abc');
    expect(timeline.samples).toHaveLength(3);
    expect(timeline.baselineRms).toBe(-30);
  });
});
