/**
 * Channel monitor: polls configured channels/playlists for new VODs and enqueues
 * them as clip jobs, de-duplicating against a persisted "seen" set so each source
 * is only clipped once. yt-dlp listing and the seen-set are injected for testing.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { dataPaths } from '../core/paths.js';
import { ytDlpBinary } from '../core/platform.js';
import type { JobQueue } from '../core/queue.js';
import { enqueueClipJob } from '../worker/index.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Lists recent video URLs for a channel/playlist. */
export interface ChannelLister {
  listVideos(channelUrl: string): Promise<string[]>;
}

/** Remembers which source URLs have already been enqueued. */
export interface SeenStore {
  has(url: string): Promise<boolean>;
  add(url: string): Promise<void>;
}

/** yt-dlp argv to flat-list the most recent videos of a channel/playlist. */
export function buildListArgs(channelUrl: string, limit: number): string[] {
  return [
    '--flat-playlist',
    '--no-warnings',
    '--print',
    '%(url)s',
    '--playlist-end',
    String(limit),
    channelUrl,
  ];
}

/** Parse yt-dlp's printed URLs (one per line). */
export function parseListOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('http'));
}

export interface ChannelListerOptions {
  runner?: CommandRunner;
  binary?: string;
  /** Max recent videos to consider per channel. */
  limit?: number;
}

export class YtDlpChannelLister implements ChannelLister {
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly limit: number;

  constructor(opts: ChannelListerOptions = {}) {
    this.runner = opts.runner ?? execaRunner;
    this.binary = opts.binary ?? ytDlpBinary();
    this.limit = opts.limit ?? 20;
  }

  async listVideos(channelUrl: string): Promise<string[]> {
    const { stdout } = await this.runner.run(this.binary, buildListArgs(channelUrl, this.limit));
    return parseListOutput(stdout);
  }
}

/** In-memory seen-set (tests / ephemeral use). */
export class MemorySeenStore implements SeenStore {
  private readonly set = new Set<string>();
  async has(url: string): Promise<boolean> {
    return this.set.has(url);
  }
  async add(url: string): Promise<void> {
    this.set.add(url);
  }
}

/** JSON-file-backed seen-set persisted under the work dir. */
export class FileSeenStore implements SeenStore {
  private set?: Set<string>;
  constructor(private readonly filePath: string) {}

  private async load(): Promise<Set<string>> {
    if (this.set) return this.set;
    try {
      this.set = new Set(JSON.parse(await readFile(this.filePath, 'utf8')) as string[]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.set = new Set();
      else throw err;
    }
    return this.set;
  }

  async has(url: string): Promise<boolean> {
    return (await this.load()).has(url);
  }

  async add(url: string): Promise<void> {
    const set = await this.load();
    set.add(url);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify([...set], null, 2), 'utf8');
  }
}

export function defaultSeenStore(): SeenStore {
  return new FileSeenStore(join(dataPaths().work, 'monitor-seen.json'));
}

export interface ChannelMonitorDeps {
  queue: JobQueue;
  lister: ChannelLister;
  seen: SeenStore;
}

export class ChannelMonitor {
  private readonly queue: JobQueue;
  private readonly lister: ChannelLister;
  private readonly seen: SeenStore;
  private readonly log = createLogger('monitor');

  constructor(deps: ChannelMonitorDeps) {
    this.queue = deps.queue;
    this.lister = deps.lister;
    this.seen = deps.seen;
  }

  /** Poll every channel once; enqueue and return the URLs newly seen. */
  async poll(channels: string[]): Promise<string[]> {
    const enqueued: string[] = [];
    for (const channel of channels) {
      let urls: string[];
      try {
        urls = await this.lister.listVideos(channel);
      } catch (err) {
        this.log.warn({ channel, err: (err as Error).message }, 'channel listing failed');
        continue;
      }
      for (const url of urls) {
        if (await this.seen.has(url)) continue;
        await enqueueClipJob(this.queue, url);
        await this.seen.add(url);
        enqueued.push(url);
      }
    }
    this.log.info({ enqueued: enqueued.length }, 'poll complete');
    return enqueued;
  }

  /** Poll on an interval until stopped. */
  async runForever(
    channels: string[],
    intervalMs: number,
    shouldStop: () => boolean = () => false,
  ): Promise<void> {
    this.log.info({ channels: channels.length, intervalMs }, 'monitor started');
    while (!shouldStop()) {
      await this.poll(channels);
      await sleep(intervalMs);
    }
  }
}
