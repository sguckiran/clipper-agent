import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Job, JobQueue, JobStatus } from '../core/queue.js';
import type { PipelineResult } from '../pipeline/index.js';
import {
  clipQuality,
  enqueueClipJob,
  enqueuePublishJob,
  PUBLISH_JOB_TYPE,
  Worker,
  type ClipPublisher,
  type SourcePipeline,
} from './index.js';

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

const resultWithClip: PipelineResult = {
  ...okResult,
  clips: [
    {
      id: 'clip-1',
      candidateId: 'cand-1',
      sourceId: 'src',
      startSec: 10,
      endSec: 40,
      caption: { text: 'caption' },
      renderedPath: 'C:\\clips\\one.mp4',
      status: 'rendered',
      candidate: {
        id: 'cand-1',
        sourceId: 'src',
        startSec: 10,
        endSec: 40,
        score: 90,
        funny: 88,
        hook: 85,
        pocket: 80,
        coherence: 92,
        reason: 'good',
        transcriptText: 'funny coherent clip',
      },
    },
  ],
};

describe('enqueueClipJob', () => {
  it('enqueues a clip job with the url payload', async () => {
    const q = new InMemoryQueue();
    const job = await enqueueClipJob(q, 'https://twitch.tv/x');
    expect(job.type).toBe('clip');
    expect(job.payload).toEqual({ url: 'https://twitch.tv/x' });
  });
});

describe('enqueuePublishJob', () => {
  it('does not enqueue duplicate active publish jobs for the same file and platform', async () => {
    const q = new InMemoryQueue();
    await enqueuePublishJob(q, {
      mediaPath: 'C:\\clips\\one.mp4',
      caption: 'caption',
      platform: 'tiktok',
    });
    await enqueuePublishJob(q, {
      mediaPath: 'C:\\clips\\one.mp4',
      caption: 'caption',
      platform: 'tiktok',
    });
    expect(await q.list()).toHaveLength(1);
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

  it('enqueues publish jobs after a successful clip job when publishing is enabled', async () => {
    const q = new InMemoryQueue();
    await enqueueClipJob(q, 'https://twitch.tv/x');
    const pipeline: SourcePipeline = { run: vi.fn().mockResolvedValue(resultWithClip) };
    const worker = new Worker(q, pipeline, {
      publishEnabled: true,
      publishMinQuality: 80,
      publishPlatforms: ['tiktok', 'instagram'],
    });

    await worker.tick();

    const jobs = await q.list();
    expect(jobs.filter((job) => job.type === PUBLISH_JOB_TYPE)).toHaveLength(2);
  });

  it('processes publish jobs with the configured publisher', async () => {
    const q = new InMemoryQueue();
    await enqueuePublishJob(q, {
      mediaPath: 'C:\\clips\\one.mp4',
      caption: 'caption',
      platform: 'tiktok',
    });
    const publisher: ClipPublisher = {
      publishFile: vi.fn().mockResolvedValue({ ok: true, results: [] }),
    };
    const worker = new Worker(q, { run: vi.fn() }, { publisher });

    await worker.tick();

    expect(publisher.publishFile).toHaveBeenCalledWith('C:\\clips\\one.mp4', 'caption', ['tiktok']);
    expect(await q.list('done')).toHaveLength(1);
  });

  it('uses platform descriptions when enqueueing publish jobs', async () => {
    const q = new InMemoryQueue();
    await enqueueClipJob(q, 'https://twitch.tv/x');
    const pipeline: SourcePipeline = {
      run: vi.fn().mockResolvedValue({
        ...resultWithClip,
        clips: [
          {
            ...resultWithClip.clips[0]!,
            caption: {
              text: 'title card',
              descriptions: {
                tiktok: 'tiktok description #fyp',
                instagram: 'instagram description #reels',
              },
            },
          },
        ],
      }),
    };
    const worker = new Worker(q, pipeline, {
      publishEnabled: true,
      publishMinQuality: 80,
      publishPlatforms: ['tiktok', 'instagram'],
    });

    await worker.tick();

    const publishJobs = (await q.list()).filter((job) => job.type === PUBLISH_JOB_TYPE);
    expect(publishJobs.map((job) => (job.payload as { caption: string }).caption)).toEqual([
      'tiktok description #fyp',
      'instagram description #reels',
    ]);
  });
});

describe('clipQuality', () => {
  it('uses the weakest required axis as the final quality gate', () => {
    expect(clipQuality(resultWithClip.clips[0]!)).toBe(85);
  });
});
