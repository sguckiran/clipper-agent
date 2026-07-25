import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Job, JobQueue, JobStatus } from '../core/queue.js';
import type { PipelineResult } from '../pipeline/index.js';
import { enqueueClipJob, Worker, type SourcePipeline } from './index.js';

/** Minimal in-memory JobQueue for worker tests. */
class InMemoryQueue implements JobQueue {
  jobs: Job[] = [];
  async enqueue<T>(type: string, payload: T): Promise<Job<T>> {
    const now = new Date().toISOString();
    const job: Job<T> = {
      id: randomUUID(),
      type,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.push(job as Job);
    return job;
  }
  async claimNext(): Promise<Job | undefined> {
    const job = this.jobs.find((j) => j.status === 'pending');
    if (!job) return undefined;
    job.status = 'running';
    job.attempts += 1;
    return job;
  }
  async complete(id: string): Promise<void> {
    this.byId(id).status = 'done';
  }
  async fail(id: string, error: string): Promise<void> {
    const j = this.byId(id);
    j.status = 'failed';
    j.error = error;
  }
  async reschedule(id: string): Promise<void> {
    this.byId(id).status = 'pending';
  }
  async list(status?: JobStatus): Promise<Job[]> {
    return status ? this.jobs.filter((j) => j.status === status) : this.jobs;
  }
  private byId(id: string): Job {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error('missing');
    return j;
  }
}

const okResult: PipelineResult = {
  source: {
    id: 'src',
    url: 'u',
    platform: 'twitch',
    title: 't',
    durationSec: 1,
    localPath: '/p',
    downloadedAt: '2026-01-01T00:00:00.000Z',
  },
  clips: [],
};

describe('enqueueClipJob', () => {
  it('enqueues a clip job with the url payload', async () => {
    const q = new InMemoryQueue();
    const job = await enqueueClipJob(q, 'https://twitch.tv/x');
    expect(job.type).toBe('clip');
    expect(job.payload).toEqual({ url: 'https://twitch.tv/x' });
  });
});

describe('Worker', () => {
  it('completes a job on success', async () => {
    const q = new InMemoryQueue();
    await enqueueClipJob(q, 'https://twitch.tv/x');
    const pipeline: SourcePipeline = { run: vi.fn().mockResolvedValue(okResult) };
    const worker = new Worker(q, pipeline);

    const job = await worker.tick();
    expect(job).toBeDefined();
    expect(pipeline.run).toHaveBeenCalledWith('https://twitch.tv/x', undefined);
    expect((await q.list('done')).length).toBe(1);
  });

  it('returns undefined when the queue is empty', async () => {
    const worker = new Worker(new InMemoryQueue(), { run: vi.fn() });
    expect(await worker.tick()).toBeUndefined();
  });

  it('retries then fails after the attempt cap', async () => {
    const q = new InMemoryQueue();
    await enqueueClipJob(q, 'https://twitch.tv/x');
    const pipeline: SourcePipeline = { run: vi.fn().mockRejectedValue(new Error('boom')) };
    const worker = new Worker(q, pipeline, { maxAttempts: 2 });

    await worker.drain();

    const failed = await q.list('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.attempts).toBe(2);
    expect(failed[0]?.error).toBe('boom');
    expect(pipeline.run).toHaveBeenCalledTimes(2);
  });

  it('drains multiple pending jobs', async () => {
    const q = new InMemoryQueue();
    await enqueueClipJob(q, 'a');
    await enqueueClipJob(q, 'b');
    const worker = new Worker(q, { run: vi.fn().mockResolvedValue(okResult) });
    expect(await worker.drain()).toBe(2);
  });
});
