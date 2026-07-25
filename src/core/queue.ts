/**
 * Minimal persistent job queue. The worker module (PR #8) builds its scheduler
 * and pipeline orchestration on top of this. Jobs are stored as JSON on disk so
 * the 24/7 worker survives restarts without losing in-flight work.
 *
 * This is intentionally simple (single-process, file-backed). If throughput ever
 * demands it, the {@link JobQueue} interface can be re-backed by SQLite/Redis
 * without touching callers.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDataDirs } from './paths.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job<T = unknown> {
  id: string;
  type: string;
  payload: T;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface JobQueue {
  enqueue<T>(type: string, payload: T): Promise<Job<T>>;
  claimNext(): Promise<Job | undefined>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  /** Return a job to the pending pool for a later retry (attempt count is preserved). */
  reschedule(id: string): Promise<void>;
  list(status?: JobStatus): Promise<Job[]>;
}

interface QueueFile {
  jobs: Job[];
}

const QUEUE_FILENAME = 'queue.json';

/** File-backed JobQueue. One instance per process. */
export class FileJobQueue implements JobQueue {
  private filePath?: string;

  private async path(): Promise<string> {
    if (!this.filePath) {
      const paths = await ensureDataDirs();
      this.filePath = join(paths.work, QUEUE_FILENAME);
    }
    return this.filePath;
  }

  private async read(): Promise<QueueFile> {
    const p = await this.path();
    try {
      const raw = await readFile(p, 'utf8');
      return JSON.parse(raw) as QueueFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [] };
      throw err;
    }
  }

  private async write(data: QueueFile): Promise<void> {
    const p = await this.path();
    await writeFile(p, JSON.stringify(data, null, 2), 'utf8');
  }

  async enqueue<T>(type: string, payload: T): Promise<Job<T>> {
    const data = await this.read();
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
    data.jobs.push(job as Job);
    await this.write(data);
    return job;
  }

  async claimNext(): Promise<Job | undefined> {
    const data = await this.read();
    const job = data.jobs.find((j) => j.status === 'pending');
    if (!job) return undefined;
    job.status = 'running';
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    await this.write(data);
    return job;
  }

  async complete(id: string): Promise<void> {
    await this.mutate(id, (job) => {
      job.status = 'done';
    });
  }

  async fail(id: string, error: string): Promise<void> {
    await this.mutate(id, (job) => {
      job.status = 'failed';
      job.error = error;
    });
  }

  async reschedule(id: string): Promise<void> {
    await this.mutate(id, (job) => {
      job.status = 'pending';
    });
  }

  async list(status?: JobStatus): Promise<Job[]> {
    const data = await this.read();
    return status ? data.jobs.filter((j) => j.status === status) : data.jobs;
  }

  private async mutate(id: string, fn: (job: Job) => void): Promise<void> {
    const data = await this.read();
    const job = data.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`Job not found: ${id}`);
    fn(job);
    job.updatedAt = new Date().toISOString();
    await this.write(data);
  }
}
