import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../core/exec.js';
import type { SourceVideo } from '../core/types.js';
import {
  buildAudioExtractArgs,
  GroqTranscriber,
  mapTranscriptionResponse,
  type TranscriptionClient,
} from './index.js';

describe('buildAudioExtractArgs', () => {
  it('downmixes to 16k mono', () => {
    const args = buildAudioExtractArgs('/in.mp4', '/out.mp3');
    expect(args).toEqual([
      '-y',
      '-i',
      '/in.mp4',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '64k',
      '/out.mp3',
    ]);
  });
});

describe('mapTranscriptionResponse', () => {
  it('maps segments and derives fullText from text', () => {
    const t = mapTranscriptionResponse('s1', {
      text: '  hello world  ',
      language: 'en',
      segments: [
        { start: 0, end: 2, text: ' hello ' },
        { start: 2, end: 4, text: 'world' },
      ],
    });
    expect(t.language).toBe('en');
    expect(t.fullText).toBe('hello world');
    expect(t.segments).toEqual([
      { start: 0, end: 2, text: 'hello' },
      { start: 2, end: 4, text: 'world' },
    ]);
  });

  it('assigns words to the segment they start in', () => {
    const t = mapTranscriptionResponse('s1', {
      segments: [
        { start: 0, end: 2, text: 'hi there' },
        { start: 2, end: 4, text: 'again' },
      ],
      words: [
        { start: 0, end: 0.5, word: 'hi' },
        { start: 1, end: 1.5, word: 'there' },
        { start: 3, end: 3.5, word: 'again' },
      ],
    });
    expect(t.segments[0]?.words).toEqual([
      { start: 0, end: 0.5, text: 'hi' },
      { start: 1, end: 1.5, text: 'there' },
    ]);
    expect(t.segments[1]?.words).toEqual([{ start: 3, end: 3.5, text: 'again' }]);
  });

  it('falls back to joined segment text and unknown language', () => {
    const t = mapTranscriptionResponse('s1', {
      segments: [
        { start: 0, end: 1, text: 'a' },
        { start: 1, end: 2, text: 'b' },
      ],
    });
    expect(t.fullText).toBe('a b');
    expect(t.language).toBe('unknown');
  });
});

describe('GroqTranscriber', () => {
  const source: SourceVideo = {
    id: 'abc',
    url: 'https://twitch.tv/x',
    platform: 'twitch',
    title: 't',
    durationSec: 100,
    localPath: '/dl/abc.mp4',
    downloadedAt: '2026-01-01T00:00:00.000Z',
  };

  it('extracts audio then transcribes the extracted file', async () => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const client: TranscriptionClient = {
      transcribe: vi.fn().mockResolvedValue({
        text: 'hi',
        language: 'en',
        segments: [{ start: 0, end: 1, text: 'hi' }],
      }),
    };
    const t = new GroqTranscriber({
      client,
      runner,
      ffmpeg: 'ffmpeg',
      model: 'whisper',
      workDir: '/work',
    });
    const transcript = await t.transcribe(source);

    expect(runner.run).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-i', '/dl/abc.mp4']),
    );
    expect(client.transcribe).toHaveBeenCalledWith({
      filePath: join('/work', 'abc.mp3'),
      model: 'whisper',
    });
    expect(transcript.sourceId).toBe('abc');
    expect(transcript.fullText).toBe('hi');
  });
});
