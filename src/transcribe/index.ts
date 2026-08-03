/**
 * Transcribe module: extracts audio with ffmpeg and transcribes it via an injected
 * speech-to-text API client. Implements the {@link Transcriber} contract. The client and
 * the subprocess runner are injected so tests never touch ffmpeg or the network.
 *
 * Long VODs exceed Whisper's upload size limit, so the audio is downmixed to
 * 16 kHz mono AND split into fixed-length chunks with ffmpeg's segment muxer.
 * Each chunk is transcribed separately and its timestamps are offset back to the
 * source timeline (using the exact chunk start times from the segment list),
 * then merged into one {@link Transcript}.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getConfig } from '../config/index.js';
import type { Transcriber } from '../core/contracts.js';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { ensureDataDirs } from '../core/paths.js';
import { ffmpegBinary } from '../core/platform.js';
import { retry } from '../core/retry.js';
import type { SourceVideo, Transcript, TranscriptSegment, TranscriptWord } from '../core/types.js';

/** Raw shape returned by a Whisper `verbose_json` transcription. */
export interface TranscriptionResponse {
  text?: string;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ start: number; end: number; word?: string; text?: string }>;
}

/** Minimal speech-to-text client the transcriber depends on (provider adapters live beside it). */
export interface TranscriptionClient {
  transcribe(input: { filePath: string; model: string }): Promise<TranscriptionResponse>;
}

/**
 * ffmpeg argv to downmix audio to 16 kHz mono and split it into `segmentSeconds`
 * chunks. Each chunk's timestamps reset to 0; the exact start of each is written to
 * `listPath` as CSV (`filename,start,end`) so callers can offset back to the source.
 */
export function buildAudioSegmentArgs(
  input: string,
  outPattern: string,
  listPath: string,
  segmentSeconds: number,
): string[] {
  return [
    '-y',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '64k',
    '-f',
    'segment',
    '-segment_time',
    String(segmentSeconds),
    '-reset_timestamps',
    '1',
    '-segment_list',
    listPath,
    '-segment_list_type',
    'csv',
    outPattern,
  ];
}

export interface AudioChunk {
  file: string;
  start: number;
}

/** Parse ffmpeg's segment-list CSV (`filename,start,end`) into chunk descriptors. */
export function parseSegmentList(csv: string): AudioChunk[] {
  return csv
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split(',');
      const start = Number.parseFloat(parts[1] ?? '');
      return { file: parts[0] ?? '', start: Number.isFinite(start) ? start : 0 };
    })
    .filter((c) => c.file.length > 0);
}

/** Assign top-level Whisper words to the segment whose time-range they start in. */
function wordsForSegment(
  segStart: number,
  segEnd: number,
  offsetSec: number,
  words: NonNullable<TranscriptionResponse['words']>,
): TranscriptWord[] {
  return words
    .filter((w) => w.start >= segStart && w.start < segEnd)
    .map((w) => ({
      start: w.start + offsetSec,
      end: w.end + offsetSec,
      text: (w.word ?? w.text ?? '').trim(),
    }));
}

/**
 * Map a raw Whisper response into domain {@link TranscriptSegment}s, shifting all
 * timestamps by `offsetSec` (the chunk's start in the source). Pure + tested.
 */
export function mapSegments(res: TranscriptionResponse, offsetSec = 0): TranscriptSegment[] {
  const words = res.words ?? [];
  return (res.segments ?? []).map((s) => {
    const segWords =
      words.length > 0 ? wordsForSegment(s.start, s.end, offsetSec, words) : undefined;
    const segment: TranscriptSegment = {
      start: s.start + offsetSec,
      end: s.end + offsetSec,
      text: s.text.trim(),
    };
    if (segWords && segWords.length > 0) segment.words = segWords;
    return segment;
  });
}

export interface TranscriberOptions {
  client: TranscriptionClient;
  runner?: CommandRunner;
  ffmpeg?: string;
  model?: string;
  /** Chunk length in seconds; falls back to config. Keep each chunk under the API limit. */
  chunkSeconds?: number;
  /** Retries per chunk on transient transcription errors (default 4). */
  chunkRetries?: number;
  /** Directory for the extracted audio; falls back to the data artifacts dir. */
  workDir?: string;
}

export class GroqTranscriber implements Transcriber {
  private readonly client: TranscriptionClient;
  private readonly runner: CommandRunner;
  private readonly ffmpeg: string;
  private readonly model: string;
  private readonly chunkSeconds: number;
  private readonly chunkRetries: number;
  private readonly workDirOverride?: string;
  private readonly log = createLogger('transcribe');

  constructor(opts: TranscriberOptions) {
    this.client = opts.client;
    this.runner = opts.runner ?? execaRunner;
    this.ffmpeg = opts.ffmpeg ?? ffmpegBinary();
    this.model = opts.model ?? getConfig().llm.transcribeModel;
    this.chunkSeconds = opts.chunkSeconds ?? getConfig().llm.transcribeChunkSec;
    this.chunkRetries = opts.chunkRetries ?? 4;
    this.workDirOverride = opts.workDir;
  }

  async transcribe(source: SourceVideo): Promise<Transcript> {
    const workDir = this.workDirOverride ?? (await ensureDataDirs()).artifacts;
    const outPattern = join(workDir, `${source.id}.%03d.mp3`);
    const listPath = join(workDir, `${source.id}.segments.csv`);

    this.log.info(
      { id: source.id, chunkSeconds: this.chunkSeconds },
      'extracting + chunking audio',
    );
    await this.runner.run(
      this.ffmpeg,
      buildAudioSegmentArgs(source.localPath, outPattern, listPath, this.chunkSeconds),
    );

    const chunks = parseSegmentList(await readFile(listPath, 'utf8'));
    this.log.info(
      { id: source.id, chunks: chunks.length, model: this.model },
      'transcribing chunks',
    );

    const segments: TranscriptSegment[] = [];
    const textParts: string[] = [];
    let language: string | undefined;
    let failedChunks = 0;
    for (const [i, chunk] of chunks.entries()) {
      const filePath = join(workDir, basename(chunk.file));
      this.log.info({ id: source.id, chunk: i + 1, of: chunks.length }, 'transcribing chunk');
      try {
        // Retry transient network/rate-limit errors; skip a chunk that never succeeds
        // rather than failing the whole (potentially multi-hour) VOD.
        const res = await retry(() => this.client.transcribe({ filePath, model: this.model }), {
          retries: this.chunkRetries,
          baseDelayMs: 1000,
          onRetry: (err, attempt) =>
            this.log.warn(
              { id: source.id, chunk: i + 1, attempt, err: (err as Error).message },
              'chunk transcription retry',
            ),
        });
        segments.push(...mapSegments(res, chunk.start));
        const text = (res.text ?? '').trim();
        if (text) textParts.push(text);
        language ??= res.language;
      } catch (err) {
        failedChunks++;
        this.log.error(
          { id: source.id, chunk: i + 1, err: (err as Error).message },
          'chunk transcription failed after retries; skipping',
        );
      }
    }
    if (chunks.length > 0 && failedChunks === chunks.length) {
      throw new Error(`transcription failed: all ${chunks.length} chunks errored`);
    }

    const transcript: Transcript = {
      sourceId: source.id,
      language: language ?? 'unknown',
      segments,
      fullText: textParts.join(' ').trim(),
    };
    this.log.info({ id: source.id, segments: segments.length }, 'transcription complete');
    return transcript;
  }
}
