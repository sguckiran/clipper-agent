/**
 * Transcribe module: extracts audio with ffmpeg and transcribes it via Groq
 * Whisper. Implements the {@link Transcriber} contract. The Whisper client and
 * the subprocess runner are injected so tests never touch ffmpeg or the network.
 *
 * NOTE: long VODs can exceed the Whisper upload size limit. Audio is downmixed to
 * 16 kHz mono to shrink it; chunking large sources is a documented follow-up.
 */
import { join } from 'node:path';
import { getConfig } from '../config/index.js';
import type { Transcriber } from '../core/contracts.js';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { ensureDataDirs } from '../core/paths.js';
import { ffmpegBinary } from '../core/platform.js';
import type { SourceVideo, Transcript, TranscriptSegment, TranscriptWord } from '../core/types.js';

/** Raw shape returned by a Whisper `verbose_json` transcription. */
export interface TranscriptionResponse {
  text?: string;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ start: number; end: number; word?: string; text?: string }>;
}

/** Minimal Whisper client the transcriber depends on (adapter in ./groq-client.ts). */
export interface TranscriptionClient {
  transcribe(input: { filePath: string; model: string }): Promise<TranscriptionResponse>;
}

/** ffmpeg argv to downmix a source's audio to 16 kHz mono for transcription. */
export function buildAudioExtractArgs(input: string, output: string): string[] {
  return ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', output];
}

/** Assign top-level Whisper words to the segment whose time-range they start in. */
function wordsForSegment(
  segStart: number,
  segEnd: number,
  words: NonNullable<TranscriptionResponse['words']>,
): TranscriptWord[] {
  return words
    .filter((w) => w.start >= segStart && w.start < segEnd)
    .map((w) => ({ start: w.start, end: w.end, text: (w.word ?? w.text ?? '').trim() }));
}

/** Map a raw Whisper response into the domain {@link Transcript}. Pure + tested. */
export function mapTranscriptionResponse(sourceId: string, res: TranscriptionResponse): Transcript {
  const words = res.words ?? [];
  const segments: TranscriptSegment[] = (res.segments ?? []).map((s) => {
    const segWords = words.length > 0 ? wordsForSegment(s.start, s.end, words) : undefined;
    const segment: TranscriptSegment = { start: s.start, end: s.end, text: s.text.trim() };
    if (segWords && segWords.length > 0) segment.words = segWords;
    return segment;
  });
  const fullText = (res.text ?? segments.map((s) => s.text).join(' ')).trim();
  return { sourceId, language: res.language ?? 'unknown', segments, fullText };
}

export interface TranscriberOptions {
  client: TranscriptionClient;
  runner?: CommandRunner;
  ffmpeg?: string;
  model?: string;
  /** Directory for the extracted audio; falls back to the data artifacts dir. */
  workDir?: string;
}

export class GroqTranscriber implements Transcriber {
  private readonly client: TranscriptionClient;
  private readonly runner: CommandRunner;
  private readonly ffmpeg: string;
  private readonly model: string;
  private readonly workDirOverride?: string;
  private readonly log = createLogger('transcribe');

  constructor(opts: TranscriberOptions) {
    this.client = opts.client;
    this.runner = opts.runner ?? execaRunner;
    this.ffmpeg = opts.ffmpeg ?? ffmpegBinary();
    this.model = opts.model ?? getConfig().llm.whisperModel;
    this.workDirOverride = opts.workDir;
  }

  async transcribe(source: SourceVideo): Promise<Transcript> {
    const workDir = this.workDirOverride ?? (await ensureDataDirs()).artifacts;
    const audioPath = join(workDir, `${source.id}.mp3`);
    this.log.info({ id: source.id }, 'extracting audio');
    await this.runner.run(this.ffmpeg, buildAudioExtractArgs(source.localPath, audioPath));

    this.log.info({ id: source.id, model: this.model }, 'transcribing');
    const res = await this.client.transcribe({ filePath: audioPath, model: this.model });
    const transcript = mapTranscriptionResponse(source.id, res);
    this.log.info(
      { id: source.id, segments: transcript.segments.length },
      'transcription complete',
    );
    return transcript;
  }
}
