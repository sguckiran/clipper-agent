/**
 * Worker: drains the persistent job queue, running the clipping pipeline per job.
 * Failed jobs are retried up to a cap (attempts are tracked by the queue) and then
 * marked failed. The pipeline is injected as an interface so the worker is tested
 * without any real modules.
 */
import type { DetectOptions } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import type { Job, JobQueue } from '../core/queue.js';
import type { Clip, PublishTarget } from '../core/types.js';
import type { PipelineResult } from '../pipeline/index.js';

/** Job type for "clip this source URL" jobs. */
export const CLIP_JOB_TYPE = 'clip';
export const PUBLISH_JOB_TYPE = 'publish';

export interface ClipJobPayload {
  url: string;
  detect?: DetectOptions;
}

export type BrowserPublishTarget = Extract<PublishTarget, 'tiktok' | 'instagram'>;

export interface PublishJobPayload {
  mediaPath: string;
  caption: string;
  platform: BrowserPublishTarget;
  clipId?: string;
  sourceId?: string;
  quality?: number;
}

/** The subset of ClippingPipeline the worker needs (keeps tests Groq-free). */
export interface SourcePipeline {
  run(url: string, opts?: DetectOptions): Promise<PipelineResult>;
}

export interface ClipPublisher {
  publishFile(
    mediaPath: string,
    caption: string,
    platforms: BrowserPublishTarget[],
  ): Promise<{ ok: boolean; error?: string; results?: { status: string; error?: string }[] }>;
}

/** Enqueue a clip job for a source URL. */
export function enqueueClipJob(
  queue: JobQueue,
  url: string,
  detect?: DetectOptions,
): Promise<Job<ClipJobPayload>> {
  return queue.enqueue<ClipJobPayload>(CLIP_JOB_TYPE, detect ? { url, detect } : { url });
}

export async function enqueuePublishJob(
  queue: JobQueue,
  payload: PublishJobPayload,
): Promise<Job<PublishJobPayload>> {
  const existing = (await queue.list()).find((job) => {
    if (job.type !== PUBLISH_JOB_TYPE) return false;
    const other = job.payload as PublishJobPayload;
    return (
      other.mediaPath === payload.mediaPath &&
      other.platform === payload.platform &&
      job.status !== 'failed'
    );
  });
  if (existing) return existing as Job<PublishJobPayload>;
  return queue.enqueue<PublishJobPayload>(PUBLISH_JOB_TYPE, payload);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WorkerOptions {
  maxAttempts?: number;
  publisher?: ClipPublisher;
  publishEnabled?: boolean;
  publishMinQuality?: number;
  publishPlatforms?: BrowserPublishTarget[];
}

export class Worker {
  private readonly queue: JobQueue;
  private readonly pipeline: SourcePipeline;
  private readonly maxAttempts: number;
  private readonly publisher?: ClipPublisher;
  private readonly publishEnabled: boolean;
  private readonly publishMinQuality: number;
  private readonly publishPlatforms: BrowserPublishTarget[];
  private readonly log = createLogger('worker');

  constructor(queue: JobQueue, pipeline: SourcePipeline, opts: WorkerOptions = {}) {
    this.queue = queue;
    this.pipeline = pipeline;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.publisher = opts.publisher;
    this.publishEnabled = opts.publishEnabled ?? false;
    this.publishMinQuality = opts.publishMinQuality ?? 75;
    this.publishPlatforms = opts.publishPlatforms ?? ['tiktok', 'instagram'];
  }

  /** Claim and process one pending job. Returns the job handled, or undefined if idle. */
  async tick(): Promise<Job | undefined> {
    const job = await this.queue.claimNext();
    if (!job) return undefined;
    this.log.info({ id: job.id, type: job.type, attempt: job.attempts }, 'processing job');
    try {
      if (job.type === CLIP_JOB_TYPE) {
        await this.processClipJob(job as Job<ClipJobPayload>);
      } else if (job.type === PUBLISH_JOB_TYPE) {
        await this.processPublishJob(job as Job<PublishJobPayload>);
      } else {
        throw new Error(`unknown job type: ${job.type}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (job.type === PUBLISH_JOB_TYPE || job.attempts >= this.maxAttempts) {
        this.log.error({ id: job.id, err: msg }, 'job failed permanently');
        await this.queue.fail(job.id, msg);
      } else {
        this.log.warn({ id: job.id, err: msg, attempt: job.attempts }, 'job failed; will retry');
        await this.queue.reschedule(job.id);
      }
    }
    return job;
  }

  private async processClipJob(job: Job<ClipJobPayload>): Promise<void> {
    const payload = job.payload;
    this.log.info({ id: job.id, url: payload.url, attempt: job.attempts }, 'processing clip job');
    const result = await this.pipeline.run(payload.url, payload.detect);
    if (this.publishEnabled) {
      await this.enqueueRenderedClipsForPublishing(result.clips);
    }
    await this.queue.complete(job.id);
    this.log.info({ id: job.id, clips: result.clips.length }, 'clip job complete');
  }

  private async processPublishJob(job: Job<PublishJobPayload>): Promise<void> {
    if (!this.publisher) throw new Error('publishing is enabled but no publisher is configured');
    const payload = job.payload;
    this.log.info(
      { id: job.id, platform: payload.platform, path: payload.mediaPath },
      'processing publish job',
    );
    const result = await this.publisher.publishFile(payload.mediaPath, payload.caption, [
      payload.platform,
    ]);
    if (!result.ok) {
      const reason =
        result.error ??
        result.results?.find((item) => item.status !== 'published')?.error ??
        'publisher returned a non-success result';
      throw new Error(reason);
    }
    await this.queue.complete(job.id);
    this.log.info({ id: job.id, platform: payload.platform }, 'publish job complete');
  }

  private async enqueueRenderedClipsForPublishing(clips: Clip[]): Promise<void> {
    let enqueued = 0;
    for (const clip of clips) {
      const mediaPath = clip.renderedPath;
      const quality = clipQuality(clip);
      if (!mediaPath || quality < this.publishMinQuality) continue;
      for (const platform of this.publishPlatforms) {
        await enqueuePublishJob(this.queue, {
          mediaPath,
          caption: clip.caption.text,
          platform,
          clipId: clip.id,
          sourceId: clip.sourceId,
          quality,
        });
        enqueued++;
      }
    }
    this.log.info({ enqueued, minQuality: this.publishMinQuality }, 'publish jobs enqueued');
  }

  /** Process pending jobs until the queue is empty. Returns how many were handled. */
  async drain(): Promise<number> {
    let handled = 0;
    while (await this.tick()) handled++;
    return handled;
  }

  /** Long-running loop for the CLI: process jobs, sleeping when idle. */
  async runForever(pollMs = 5000, shouldStop: () => boolean = () => false): Promise<void> {
    this.log.info({ pollMs }, 'worker started');
    while (!shouldStop()) {
      const job = await this.tick();
      if (!job) await sleep(pollMs);
    }
  }
}

function clampScore(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value ?? 0)));
}

export function clipQuality(clip: Clip): number {
  const candidate = clip.candidate;
  if (!candidate) return 0;
  return Math.min(
    clampScore(candidate.score),
    clampScore(candidate.funny),
    clampScore(candidate.hook),
    clampScore(candidate.coherence),
  );
}
