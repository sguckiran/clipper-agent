/**
 * Pipeline orchestrator: chains the modules for one source, end to end.
 *
 *   URL → download → (transcribe ‖ loudness) → detect → caption → render → Clip[]
 *
 * Every stage is injected as its contract, so the whole flow is unit-tested with
 * fakes. Publishing is intentionally out of scope — the pipeline stops at rendered
 * clips on disk.
 */
import type {
  CaptionWriter,
  ClipDetector,
  DetectOptions,
  Downloader,
  LoudnessAnalyzer,
  Renderer,
  Transcriber,
} from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import { isValidClipLength, type Clip, type SourceVideo } from '../core/types.js';

export interface PipelineDeps {
  downloader: Downloader;
  transcriber: Transcriber;
  loudness: LoudnessAnalyzer;
  detector: ClipDetector;
  captionWriter: CaptionWriter;
  renderer: Renderer;
}

export type PipelineOptions = DetectOptions;

export interface PipelineResult {
  source: SourceVideo;
  clips: Clip[];
}

export class ClippingPipeline {
  private readonly deps: PipelineDeps;
  private readonly log = createLogger('pipeline');

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  async run(url: string, opts: PipelineOptions = {}): Promise<PipelineResult> {
    this.log.info({ url }, 'pipeline start');
    const source = await this.deps.downloader.download(url);
    return this.runSource(source, opts);
  }

  /** Run the pipeline on an already-downloaded source (skips the download step). */
  async runSource(source: SourceVideo, opts: PipelineOptions = {}): Promise<PipelineResult> {
    this.log.info({ source: source.id, path: source.localPath }, 'processing source');

    // Transcription and loudness are independent reads of the source; run together.
    const [transcript, loudness] = await Promise.all([
      this.deps.transcriber.transcribe(source),
      this.deps.loudness.analyze(source),
    ]);

    const candidates = await this.deps.detector.detect(transcript, loudness, opts);
    this.log.info({ candidates: candidates.length }, 'candidates detected');

    const clips: Clip[] = [];
    for (const candidate of candidates) {
      if (!isValidClipLength(candidate)) {
        this.log.warn({ id: candidate.id }, 'skipping candidate: violates clip-length rule');
        continue;
      }
      const caption = await this.deps.captionWriter.write(candidate);
      const clip = await this.deps.renderer.render(source, candidate, caption);
      clips.push(clip);
    }

    this.log.info({ source: source.id, clips: clips.length }, 'pipeline complete');
    return { source, clips };
  }
}
