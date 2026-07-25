import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import type { SourceVideo } from '../core/types.js';
import {
  buildAudioSegmentArgs,
  GroqTranscriber,
  mapSegments,
  parseSegmentList,
  type TranscriptionClient,
} from './index.js';

describe('buildAudioSegmentArgs', () => {
  it('downmixes to 16k mono and segments with a csv list', () => {
    const args = buildAudioSegmentArgs('/in.mp4', '/out.%03d.mp3', '/list.csv', 600);
    expect(args).toEqual(
      expect.arrayContaining([
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'segment',
        '-reset_timestamps',
        '1',
      ]),
    );
    expect(args[args.indexOf('-segment_time') + 1]).toBe('600');
    expect(args[args.indexOf('-segment_list') + 1]).toBe('/list.csv');
    expect(args[args.length - 1]).toBe('/out.%03d.mp3');
  });
});

describe('parseSegmentList', () => {
  it('parses filename + start from the csv', () => {
    const csv = 'src.000.mp3,0.000000,600.000000\nsrc.001.mp3,600.000000,1200.000000\n';
    expect(parseSegmentList(csv)).toEqual([
      { file: 'src.000.mp3', start: 0 },
      { file: 'src.001.mp3', start: 600 },
    ]);
  });

  it('ignores blank lines', () => {
    expect(parseSegmentList('\n  \n')).toEqual([]);
  });
});

describe('mapSegments', () => {
  it('offsets segment and word timestamps by the chunk start', () => {
    const segs = mapSegments(
      {
        segments: [{ start: 1, end: 3, text: ' hi ' }],
        words: [{ start: 1, end: 1.5, word: 'hi' }],
      },
      600,
    );
    expect(segs).toEqual([
      { start: 601, end: 603, text: 'hi', words: [{ start: 601, end: 601.5, text: 'hi' }] },
    ]);
  });

  it('defaults to no offset', () => {
    expect(mapSegments({ segments: [{ start: 0, end: 1, text: 'a' }] })).toEqual([
      { start: 0, end: 1, text: 'a' },
    ]);
  });
});

describe('GroqTranscriber', () => {
  const source: SourceVideo = {
    id: 'abc',
    url: 'https://twitch.tv/x',
    platform: 'twitch',
    title: 't',
    durationSec: 1200,
    localPath: '/dl/abc.mp4',
    downloadedAt: '2026-01-01T00:00:00.000Z',
  };

  it('chunks, transcribes each chunk and merges with offsets', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'clipper-tx-'));
    // Simulate what the ffmpeg segment muxer would have written.
    await writeFile(
      join(workDir, 'abc.segments.csv'),
      'abc.000.mp3,0.000000,600.000000\nabc.001.mp3,600.000000,1200.000000\n',
    );

    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const client: TranscriptionClient = {
      transcribe: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'first',
          language: 'en',
          segments: [{ start: 5, end: 7, text: 'first' }],
        })
        .mockResolvedValueOnce({
          text: 'second',
          segments: [{ start: 2, end: 4, text: 'second' }],
        }),
    };

    const t = new GroqTranscriber({
      client,
      runner,
      ffmpeg: 'ffmpeg',
      model: 'whisper',
      chunkSeconds: 600,
      workDir,
    });
    const transcript = await t.transcribe(source);

    // one ffmpeg segment call, one transcribe call per chunk
    expect(runner.run).toHaveBeenCalledOnce();
    expect(client.transcribe).toHaveBeenCalledTimes(2);
    expect(client.transcribe).toHaveBeenNthCalledWith(1, {
      filePath: join(workDir, 'abc.000.mp3'),
      model: 'whisper',
    });

    expect(transcript.language).toBe('en');
    expect(transcript.fullText).toBe('first second');
    expect(transcript.segments).toEqual([
      { start: 5, end: 7, text: 'first' }, // chunk 0, offset 0
      { start: 602, end: 604, text: 'second' }, // chunk 1, offset 600
    ]);
  });

  it('skips a chunk that fails after retries instead of aborting', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'clipper-tx-'));
    await writeFile(
      join(workDir, 'abc.segments.csv'),
      'abc.000.mp3,0.000000,600.000000\nabc.001.mp3,600.000000,1200.000000\n',
    );
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const client: TranscriptionClient = {
      transcribe: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'ok',
          language: 'en',
          segments: [{ start: 1, end: 2, text: 'ok' }],
        })
        .mockRejectedValue(new Error('boom')),
    };
    const t = new GroqTranscriber({
      client,
      runner,
      ffmpeg: 'ffmpeg',
      model: 'whisper',
      chunkSeconds: 600,
      chunkRetries: 0, // fail fast, no real backoff sleeps
      workDir,
    });
    const transcript = await t.transcribe(source);
    expect(transcript.segments).toEqual([{ start: 1, end: 2, text: 'ok' }]);
    expect(transcript.fullText).toBe('ok');
  });

  it('throws only when every chunk fails', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'clipper-tx-'));
    await writeFile(join(workDir, 'abc.segments.csv'), 'abc.000.mp3,0.000000,600.000000\n');
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const client: TranscriptionClient = {
      transcribe: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const t = new GroqTranscriber({
      client,
      runner,
      ffmpeg: 'ffmpeg',
      model: 'whisper',
      chunkSeconds: 600,
      chunkRetries: 0,
      workDir,
    });
    await expect(t.transcribe(source)).rejects.toThrow(/all 1 chunks/);
  });
});
