/**
 * Worker: drains the persistent job queue, running the clipping pipeline per job.
 * Failed jobs are retried up to a cap (attempts are tracked by the queue) and then
 * marked failed. The pipeline is injected as an interface so the worker is tested
 * without any real modules.
 */
import type { DetectOptions } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import type { Job, JobQueue } from '../core/queue.js';
import type { PipelineResult } from '../pipeline/index.js';

/** Job type for "clip this source URL" jobs. */
export const CLIP_JOB_TYPE = 'clip';

export interface ClipJobPayload {
  url: string;
  detect?: DetectOptions;
}

/** The subset of ClippingPipeline the worker needs (keeps tests Groq-free). */
export interface SourcePipeline {
  run(url: string, opts?: DetectOptions): Promise<PipelineResult>;
}

/** Enqueue a clip job for a source URL. */
export function enqueueClipJob(
  queue: JobQueue,
  url: string,
  detect?: DetectOptions,
): Promise<Job<ClipJobPayload>> {
  return queue.enqueue<ClipJobPayload>(CLIP_JOB_TYPE, detect ? { url, detect } : { url });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WorkerOptions {
  maxAttempts?: number;
}

export class Worker {
  private readonly queue: JobQueue;
  private readonly pipeline: SourcePipeline;
  private readonly maxAttempts: number;
  private readonly log = createLogger('worker');

  constructor(queue: JobQueue, pipeline: SourcePipeline, opts: WorkerOptions = {}) {
    this.queue = queue;
    this.pipeline = pipeline;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /** Claim and process one pending job. Returns the job handled, or undefined if idle. */
  async tick(): Promise<Job | undefined> {
    const job = await this.queue.claimNext();
    if (!job) return undefined;
    const payload = job.payload as ClipJobPayload;
    this.log.info({ id: job.id, url: payload.url, attempt: job.attempts }, 'processing job');
    try {
      const result = await this.pipeline.run(payload.url, payload.detect);
      await this.queue.complete(job.id);
      this.log.info({ id: job.id, clips: result.clips.length }, 'job complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (job.attempts >= this.maxAttempts) {
        this.log.error({ id: job.id, err: msg }, 'job failed permanently');
        await this.queue.fail(job.id, msg);
      } else {
        this.log.warn({ id: job.id, err: msg, attempt: job.attempts }, 'job failed; will retry');
        await this.queue.reschedule(job.id);
      }
    }
    return job;
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
