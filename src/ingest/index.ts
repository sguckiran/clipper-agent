/**
 * Ingest module: downloads a source livestream/VOD to local disk with yt-dlp.
 * Implements the {@link Downloader} contract. The subprocess runner is injected
 * so tests exercise arg-building and output-parsing without spawning yt-dlp.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getConfig } from '../config/index.js';
import type { Downloader, DownloadOptions } from '../core/contracts.js';
import { execaRunner, type CommandRunner } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { ensureDataDirs } from '../core/paths.js';
import { ytDlpBinary } from '../core/platform.js';
import type { SourcePlatform, SourceVideo } from '../core/types.js';

/** Field separator for our yt-dlp `--print` template. */
const FIELD_SEP = '\t';

/** Infer the source platform from a URL's host. */
export function inferPlatform(url: string): SourcePlatform {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host.includes('twitch')) return 'twitch';
  if (host.includes('youtube') || host.includes('youtu.be')) return 'youtube';
  if (host.includes('kick')) return 'kick';
  return 'other';
}

/** Stable source id derived from the URL (matches the SourceVideo.id contract). */
export function sourceIdFromUrl(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

/** Build the yt-dlp argv for downloading a single source and printing its metadata. */
export function buildDownloadArgs(url: string, outDir: string, maxHeight: number): string[] {
  return [
    '--no-playlist',
    '--no-warnings',
    '-f',
    `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`,
    '-o',
    join(outDir, '%(id)s.%(ext)s'),
    '--no-simulate',
    '--print',
    `after_move:%(id)s${FIELD_SEP}%(title)s${FIELD_SEP}%(duration)s${FIELD_SEP}%(filepath)s`,
    url,
  ];
}

export interface DownloadMeta {
  ytId: string;
  title: string;
  durationSec: number;
  filepath: string;
}

/** Parse the tab-separated line printed by {@link buildDownloadArgs}. */
export function parseDownloadOutput(stdout: string): DownloadMeta {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) throw new Error('yt-dlp produced no output to parse');
  const parts = last.split(FIELD_SEP);
  if (parts.length < 4) throw new Error(`Unexpected yt-dlp print output: ${last}`);
  const durationSec = Number.parseFloat(parts[2] ?? '');
  return {
    ytId: parts[0] ?? '',
    title: parts[1] ?? '',
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    filepath: parts[3] ?? '',
  };
}

export interface DownloaderOptions {
  runner?: CommandRunner;
  binary?: string;
  /** Default max height when a call doesn't specify one; falls back to config. */
  defaultMaxHeight?: number;
  /** Fixed output directory; falls back to the data downloads dir. */
  outDir?: string;
}

export class YtDlpDownloader implements Downloader {
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly defaultMaxHeight: number;
  private readonly outDirOverride?: string;
  private readonly log = createLogger('ingest');

  constructor(opts: DownloaderOptions = {}) {
    this.runner = opts.runner ?? execaRunner;
    this.binary = opts.binary ?? ytDlpBinary();
    this.defaultMaxHeight = opts.defaultMaxHeight ?? getConfig().ingest.maxHeight;
    this.outDirOverride = opts.outDir;
  }

  async download(url: string, opts: DownloadOptions = {}): Promise<SourceVideo> {
    const outDir = opts.outDir ?? this.outDirOverride ?? (await ensureDataDirs()).downloads;
    const maxHeight = opts.maxHeight ?? this.defaultMaxHeight;
    const args = buildDownloadArgs(url, outDir, maxHeight);
    this.log.info({ url, maxHeight }, 'downloading source');
    const { stdout } = await this.runner.run(this.binary, args);
    const meta = parseDownloadOutput(stdout);
    const source: SourceVideo = {
      id: sourceIdFromUrl(url),
      url,
      platform: inferPlatform(url),
      title: meta.title,
      durationSec: meta.durationSec,
      localPath: meta.filepath,
      downloadedAt: new Date().toISOString(),
    };
    this.log.info({ id: source.id, path: source.localPath }, 'download complete');
    return source;
  }
}

export function createDownloader(opts?: DownloaderOptions): Downloader {
  return new YtDlpDownloader(opts);
}
