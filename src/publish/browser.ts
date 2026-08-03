import { execa } from 'execa';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config/index.js';
import { dataPaths } from '../core/paths.js';
import type { Clip, PublishTarget } from '../core/types.js';

export type BrowserPublishTarget = Extract<PublishTarget, 'tiktok' | 'instagram'>;

export interface BrowserPublishResult {
  platform: BrowserPublishTarget;
  status: 'published' | 'needs_human' | 'failed';
  error?: string;
  screenshot?: string | null;
}

export interface BrowserPublishResponse {
  ok: boolean;
  results: BrowserPublishResult[];
  error?: string;
}

export interface BrowserPublisherOptions {
  python?: string;
  scriptPath?: string;
  dataDir?: string;
  profileDir?: string;
  browserExecutable?: string;
  headless?: boolean;
}

export interface PublishClipOptions {
  platforms?: BrowserPublishTarget[];
  caption?: string;
}

const SUPPORTED_BROWSER_TARGETS = new Set<BrowserPublishTarget>(['tiktok', 'instagram']);

function defaultPython(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function defaultPublisherScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'python', 'clipper_publisher', 'browser_publisher.py');
}

function parseResponse(stdout: string): BrowserPublishResponse {
  const lastJsonLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{'));
  if (!lastJsonLine) {
    throw new Error(`publisher returned no JSON output: ${stdout.slice(0, 500)}`);
  }
  return JSON.parse(lastJsonLine) as BrowserPublishResponse;
}

function configuredTargets(platforms?: PublishTarget[]): BrowserPublishTarget[] {
  const selected = platforms ?? getConfig().publish.platforms;
  const supported = selected.filter((p): p is BrowserPublishTarget =>
    SUPPORTED_BROWSER_TARGETS.has(p as BrowserPublishTarget),
  );
  return supported.length > 0 ? supported : ['tiktok', 'instagram'];
}

export class BrowserPublisher {
  private readonly opts: BrowserPublisherOptions;

  constructor(opts: BrowserPublisherOptions = {}) {
    this.opts = opts;
  }

  async publishClip(clip: Clip, opts: PublishClipOptions = {}): Promise<BrowserPublishResponse> {
    if (!clip.renderedPath) throw new Error(`clip has no rendered video path: ${clip.id}`);
    return this.publishFile(clip.renderedPath, opts.caption ?? clip.caption.text, opts.platforms);
  }

  async publishFile(
    mediaPath: string,
    caption: string,
    platforms?: BrowserPublishTarget[],
  ): Promise<BrowserPublishResponse> {
    return this.call({
      action: 'publish',
      media_path: mediaPath,
      caption,
      platforms: platforms ?? configuredTargets(),
    });
  }

  async login(platform: BrowserPublishTarget): Promise<BrowserPublishResponse> {
    const payload = await this.basePayload({ action: 'login', platform });
    const python = this.opts.python ?? getConfig().publish.python ?? defaultPython();
    const script = this.opts.scriptPath ?? defaultPublisherScriptPath();
    const child = await execa(python, [script], {
      env: { CLIPPER_PUBLISH_PAYLOAD: JSON.stringify(payload) },
      stdio: 'inherit',
      reject: false,
    });
    return {
      ok: child.exitCode === 0,
      results: [],
      error: child.exitCode === 0 ? undefined : `publisher login exited with ${child.exitCode}`,
    };
  }

  private async call(payload: Record<string, unknown>): Promise<BrowserPublishResponse> {
    const fullPayload = await this.basePayload(payload);
    const python = this.opts.python ?? getConfig().publish.python ?? defaultPython();
    const script = this.opts.scriptPath ?? defaultPublisherScriptPath();
    const child = await execa(python, [script], {
      input: JSON.stringify(fullPayload),
      reject: false,
      all: true,
    });
    const response = parseResponse(child.stdout || child.all || '');
    if (child.exitCode !== 0 && !response.error && response.results?.length === 0) {
      response.error = child.stderr || child.all || `publisher exited with ${child.exitCode}`;
    }
    return response;
  }

  private async basePayload(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cfg = getConfig();
    const paths = dataPaths();
    return {
      data_dir: this.opts.dataDir ?? paths.root,
      profile_dir: this.opts.profileDir ?? cfg.publish.profileDir,
      browser_executable: this.opts.browserExecutable ?? cfg.publish.browserExecutable,
      headless: this.opts.headless ?? cfg.publish.headless,
      ...payload,
    };
  }
}

export function createBrowserPublisher(opts: BrowserPublisherOptions = {}): BrowserPublisher {
  return new BrowserPublisher(opts);
}
