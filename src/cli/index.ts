#!/usr/bin/env node
/**
 * clipper-agent CLI entrypoint.
 *
 * `doctor` verifies the environment. The pipeline commands wire the real,
 * config-backed modules:
 *   run      one-shot: URL → rendered clips on disk
 *   add      enqueue a source URL for the worker
 *   work     run the queue worker (processes enqueued sources)
 *   monitor  poll configured channels and auto-enqueue new VODs
 *   web      run a small local browser UI
 *   queue    list queued jobs
 *   prompts  inspect the prompt store
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { getConfig, resetConfigCache } from '../config/index.js';
import type { DetectOptions } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import { sourceFromLocalFile } from '../ingest/index.js';
import { dataPaths } from '../core/paths.js';
import { ffmpegBinary, platformInfo, preferredH264Encoder, ytDlpBinary } from '../core/platform.js';
import { FileJobQueue } from '../core/queue.js';
import { ChannelMonitor, YtDlpChannelLister, defaultSeenStore } from '../monitor/index.js';
import { createDefaultPipeline } from '../pipeline/factory.js';
import { createBrowserPublisher, type BrowserPublishTarget } from '../publish/browser.js';
import { FilesystemPromptStore } from '../prompts/index.js';
import { qaTarget } from '../review/index.js';
import { hashPassword, startWebServer } from '../web/index.js';
import { clipQuality, enqueueClipJob, Worker } from '../worker/index.js';

const log = createLogger('cli');
const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function checkBinary(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execa(bin, args);
    return stdout.split('\n')[0] ?? '';
  } catch {
    return null;
  }
}

async function doctor(): Promise<number> {
  const cfg = getConfig();
  const plat = platformInfo();
  const paths = dataPaths();

  log.info({ os: plat.os, appleSilicon: plat.isAppleSilicon }, 'platform');
  log.info({ encoder: preferredH264Encoder() }, 'preferred h264 encoder');
  log.info({ dataDir: paths.root }, 'data directory');

  const ffmpegVersion = await checkBinary(ffmpegBinary(), ['-version']);
  const ytDlpVersion = await checkBinary(ytDlpBinary(), ['--version']);

  let ok = true;
  if (ffmpegVersion) log.info({ ffmpeg: ffmpegVersion }, 'ffmpeg OK');
  else {
    log.error('ffmpeg not found (install it or set CLIPPER_FFMPEG_PATH)');
    ok = false;
  }
  if (ytDlpVersion) log.info({ ytDlp: ytDlpVersion }, 'yt-dlp OK');
  else {
    log.error('yt-dlp not found (install it or set CLIPPER_YT_DLP_PATH)');
    ok = false;
  }

  log.info(
    {
      provider: cfg.llm.provider,
      openai: Boolean(cfg.llm.openaiApiKey),
      groq: Boolean(cfg.llm.groqApiKey),
      anthropic: Boolean(cfg.llm.anthropicApiKey),
      transcribeModel: cfg.llm.transcribeModel,
      researchModel: cfg.llm.researchModel,
    },
    'llm credentials present',
  );

  log.info(ok ? 'doctor: environment looks healthy' : 'doctor: problems found (see above)');
  return ok ? 0 : 1;
}

/** Read a numeric CLI flag, e.g. --limit 5. */
function flagNumber(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function detectOptionsFromArgs(args: string[]): DetectOptions {
  const opts: DetectOptions = {};
  const limit = flagNumber(args, '--limit');
  const minScore = flagNumber(args, '--min-score');
  if (limit !== undefined) opts.limit = limit;
  if (minScore !== undefined) opts.minScore = minScore;
  return opts;
}

function publishMinQualityFromArgs(args: string[]): number | undefined {
  return flagNumber(args, '--publish-min-quality');
}

/** Read a string CLI flag, e.g. --out-dir ./qa. */
function flagString(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

/** First argument that isn't a flag or a flag's value. */
function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      i++; // skip the flag's value
      continue;
    }
    return a;
  }
  return undefined;
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  const valueFlags = new Set([
    '--limit',
    '--min-score',
    '--publish-min-quality',
    '--interval-min',
    '--layout',
    '--panels',
    '--platforms',
    '--caption',
    '--out-dir',
    '--frames',
    '--min-sec',
    '--max-sec',
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function publishPlatformsFromArgs(args: string[]): BrowserPublishTarget[] | undefined {
  const raw = flagString(args, '--platforms');
  if (!raw) return undefined;
  const platforms = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is BrowserPublishTarget => s === 'tiktok' || s === 'instagram');
  return platforms.length > 0 ? platforms : undefined;
}

function publishPlatformsOrTikTok(args: string[]): BrowserPublishTarget[] {
  return publishPlatformsFromArgs(args) ?? ['tiktok'];
}

function applyCampaignRenderPreset(
  args: string[],
  creatorHandle: string,
): { layout?: string; panels?: string } {
  const explicitLayout = flagString(args, '--layout');
  const explicitPanels = flagString(args, '--panels');
  const normalizedHandle = creatorHandle.trim().toLowerCase();
  const krimoePanels = '34,74,600,448;634,74,600,448';

  const layout = explicitLayout ?? (normalizedHandle === '@krimoemp4' ? 'auto' : undefined);
  const panels = explicitPanels ?? (normalizedHandle === '@krimoemp4' ? krimoePanels : undefined);
  if (layout) process.env.CLIPPER_LAYOUT = layout;
  if (panels) process.env.CLIPPER_PANELS = panels;
  return { layout, panels };
}

async function campaign(args: string[]): Promise<number> {
  const positional = positionalArgs(args);
  const creatorHandle = positional[0];
  const target = positional[1];
  if (!creatorHandle?.startsWith('@') || !target) {
    log.error(
      'usage: clipper @creator <url|file> [--limit N] [--min-score N] [--publish-min-quality N] [--interval-min 20] [--layout auto] [--panels x,y,w,h;x,y,w,h] [--platforms tiktok,instagram] [--dry-run]',
    );
    log.error('   or: clipper campaign @creator <url|file> ...');
    return 1;
  }

  process.env.CLIPPER_CREATOR_HANDLE = creatorHandle;
  const renderPreset = applyCampaignRenderPreset(args, creatorHandle);
  resetConfigCache();
  const cfg = getConfig();
  const opts = detectOptionsFromArgs(args);
  const platforms = publishPlatformsOrTikTok(args);
  const publishMinQuality = publishMinQualityFromArgs(args) ?? cfg.publish.minQuality;
  const intervalMin = Math.max(0, flagNumber(args, '--interval-min') ?? 20);
  const dryRun = args.includes('--dry-run');

  const pipeline = createDefaultPipeline();
  const isLocalFile = existsSync(target) && statSync(target).isFile();
  const result = isLocalFile
    ? await pipeline.runSource(sourceFromLocalFile(resolve(target)), opts)
    : await pipeline.run(target, opts);

  const publishable = result.clips
    .filter((clip) => clip.renderedPath && clipQuality(clip) >= publishMinQuality)
    .sort((a, b) => clipQuality(b) - clipQuality(a));

  log.info(
    {
      creatorHandle,
      source: result.source.id,
      rendered: result.clips.length,
      publishable: publishable.length,
      platforms,
      publishMinQuality,
      intervalMin,
      layout: renderPreset.layout ?? cfg.render.layout,
      panels: renderPreset.panels ? cfg.render.panels.length : 0,
      dryRun,
    },
    'campaign clipping complete',
  );

  if (publishable.length === 0) {
    log.info('no publishable clips produced');
    return 0;
  }

  if (dryRun) {
    for (const clip of publishable) {
      log.info(
        {
          path: clip.renderedPath,
          quality: clipQuality(clip),
          caption: clip.caption.descriptions?.tiktok ?? clip.caption.text,
        },
        'dry-run publish candidate',
      );
    }
    return 0;
  }

  const publisher = createBrowserPublisher();
  for (let index = 0; index < publishable.length; index++) {
    const clip = publishable[index]!;
    if (index > 0 && intervalMin > 0) {
      const delayMs = intervalMin * 60 * 1000;
      log.info(
        {
          minutes: intervalMin,
          nextAt: new Date(Date.now() + delayMs).toISOString(),
          remaining: publishable.length - index,
        },
        'waiting before next post',
      );
      await sleep(delayMs);
    }

    const caption = clip.caption.descriptions?.tiktok ?? clip.caption.text;
    log.info(
      {
        index: index + 1,
        total: publishable.length,
        path: clip.renderedPath,
        quality: clipQuality(clip),
      },
      'publishing clip',
    );
    const publishResult = await publisher.publishFile(clip.renderedPath!, caption, platforms);
    for (const item of publishResult.results) {
      log.info(
        {
          platform: item.platform,
          status: item.status,
          error: item.error,
          screenshot: item.screenshot,
        },
        'publish result',
      );
    }
    if (!publishResult.ok) {
      log.error({ err: publishResult.error }, 'publish failed; continuing to next scheduled clip');
    }
  }
  return 0;
}

async function run(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) {
    log.error('usage: clipper run <url|file> [--limit N] [--min-score N]');
    return 1;
  }
  const pipeline = createDefaultPipeline();
  const opts = detectOptionsFromArgs(args);
  // A local file path skips the download and runs the pipeline directly on it.
  const isLocalFile = existsSync(target) && statSync(target).isFile();
  const { clips } = isLocalFile
    ? await pipeline.runSource(sourceFromLocalFile(resolve(target)), opts)
    : await pipeline.run(target, opts);
  if (clips.length === 0) {
    log.info('no clips produced (nothing cleared the score threshold)');
  } else {
    for (const clip of clips)
      log.info({ path: clip.renderedPath, caption: clip.caption.text }, 'clip');
  }
  return 0;
}

async function add(args: string[]): Promise<number> {
  const url = firstPositional(args);
  if (!url) {
    log.error('usage: clipper add <url> [--limit N] [--min-score N]');
    return 1;
  }
  const job = await enqueueClipJob(new FileJobQueue(), url, detectOptionsFromArgs(args));
  log.info({ id: job.id, url }, 'enqueued');
  return 0;
}

async function work(): Promise<number> {
  const cfg = getConfig();
  const publishPlatforms = cfg.publish.platforms.filter(
    (p): p is BrowserPublishTarget => p === 'tiktok' || p === 'instagram',
  );
  const worker = new Worker(new FileJobQueue(), createDefaultPipeline(), {
    publishEnabled: cfg.publish.enabled,
    publishMinQuality: cfg.publish.minQuality,
    publishPlatforms: publishPlatforms.length > 0 ? publishPlatforms : ['tiktok', 'instagram'],
    publisher: cfg.publish.enabled ? createBrowserPublisher() : undefined,
  });
  await worker.runForever();
  return 0;
}

async function monitor(): Promise<number> {
  const cfg = getConfig();
  if (cfg.monitor.channels.length === 0) {
    log.error('no channels configured (set CLIPPER_MONITOR_CHANNELS)');
    return 1;
  }
  const mon = new ChannelMonitor({
    queue: new FileJobQueue(),
    lister: new YtDlpChannelLister(),
    seen: defaultSeenStore(),
  });
  await mon.runForever(cfg.monitor.channels, cfg.monitor.intervalSec * 1000);
  return 0;
}

async function login(args: string[]): Promise<number> {
  const platform = firstPositional(args);
  if (platform !== 'tiktok' && platform !== 'instagram') {
    log.error('usage: clipper login <tiktok|instagram>');
    return 1;
  }
  const result = await createBrowserPublisher().login(platform);
  if (!result.ok) {
    log.error({ err: result.error }, 'login failed');
    return 1;
  }
  log.info({ platform }, 'login session saved');
  return 0;
}

async function publish(args: string[]): Promise<number> {
  const mediaPath = firstPositional(args);
  if (!mediaPath) {
    log.error(
      'usage: clipper publish <clip.mp4> --caption "caption" [--platforms tiktok,instagram]',
    );
    return 1;
  }
  const absolutePath = resolve(mediaPath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    log.error({ path: absolutePath }, 'clip file not found');
    return 1;
  }
  const caption = flagString(args, '--caption') ?? '';
  const result = await createBrowserPublisher().publishFile(
    absolutePath,
    caption,
    publishPlatformsFromArgs(args),
  );
  for (const item of result.results) {
    log.info(
      {
        platform: item.platform,
        status: item.status,
        error: item.error,
        screenshot: item.screenshot,
      },
      'publish result',
    );
  }
  if (!result.ok) {
    log.error({ err: result.error }, 'publish did not fully complete');
    return 1;
  }
  return 0;
}

async function web(): Promise<number> {
  startWebServer();
  await new Promise(() => {
    // Keep the process alive until Ctrl+C.
  });
  return 0;
}

async function queue(args: string[]): Promise<number> {
  const status = firstPositional(args) as Parameters<FileJobQueue['list']>[0];
  const jobs = await new FileJobQueue().list(status);
  if (jobs.length === 0) {
    log.info('queue is empty');
    return 0;
  }
  for (const job of jobs) {
    log.info(
      {
        id: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        payload: job.payload,
      },
      'job',
    );
  }
  return 0;
}

async function qa(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) {
    log.error('usage: clipper qa <clip-file|clips-dir> [--out-dir DIR] [--frames N]');
    return 1;
  }
  const reports = await qaTarget(resolve(target), {
    outDir: flagString(args, '--out-dir'),
    frames: flagNumber(args, '--frames'),
    minSec: flagNumber(args, '--min-sec'),
    maxSec: flagNumber(args, '--max-sec'),
  });
  if (reports.length === 0) {
    log.warn({ target }, 'no video files found to review');
    return 1;
  }
  let failures = 0;
  for (const report of reports) {
    if (!report.passed) failures++;
    log.info(
      {
        path: report.clip.path,
        passed: report.passed,
        durationSec: Number(report.clip.durationSec.toFixed(1)),
        size: `${report.clip.width}x${report.clip.height}`,
        audio: report.clip.hasAudio,
        contactSheet: report.contactSheetPath,
        report: report.reportPath,
        issues: report.issues.map((i) => `${i.severity}:${i.code}`),
      },
      'qa',
    );
  }
  log.info({ clips: reports.length, failures }, 'qa complete');
  return failures > 0 ? 1 : 0;
}

async function prompts(args: string[]): Promise<number> {
  const store = new FilesystemPromptStore();
  const sub = args[0];
  if (sub === 'show') {
    const name = args[1];
    if (!name) {
      log.error('usage: clipper prompts show <name> [version]');
      return 1;
    }
    const tpl = await store.get(name, args[2]);
    log.info({ name: tpl.name, version: tpl.version, variables: tpl.variables }, 'prompt');
    console.log(tpl.template);
    return 0;
  }
  for (const tpl of await store.list()) {
    log.info({ name: tpl.name, version: tpl.version, description: tpl.description }, 'prompt');
  }
  return 0;
}

async function hashWebPassword(args: string[]): Promise<number> {
  const password = firstPositional(args);
  if (!password) {
    log.error('usage: clipper hash-password <password>');
    return 1;
  }
  console.log(hashPassword(password));
  return 0;
}

function printHelp(): void {
  console.log(
    [
      'clipper-agent',
      '',
      'Usage: clipper <command>',
      '',
      'Commands:',
      '  @creator <url> Clip and post with attribution, spaced by 20 minutes',
      '  campaign @creator <url> Same as @creator shorthand',
      '  run <url>     Clip a source now (--limit N, --min-score N)',
      '  add <url>     Enqueue a source URL for the worker',
      '  work          Run the queue worker',
      '  monitor       Poll configured channels and auto-enqueue new VODs',
      '  login <target> Save a browser session for tiktok or instagram',
      '  publish <mp4>  Publish a rendered clip (--caption "...", --platforms ...)',
      '  web           Run the local browser UI (http://localhost:3333)',
      '  queue [status] List queued jobs (pending|running|done|failed)',
      '  qa <file|dir> Review rendered clips: metadata checks + contact sheets',
      '  prompts       List prompts (or: prompts show <name> [version])',
      '  hash-password <password> Generate CLIPPER_WEB_PASSWORD_HASH for the web UI',
      '  doctor        Check environment (binaries, config, paths)',
      '  help          Show this help',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);
  switch (command) {
    case 'doctor':
      process.exitCode = await doctor();
      break;
    case 'campaign':
      process.exitCode = await campaign(rest);
      break;
    case 'run':
      process.exitCode = await run(rest);
      break;
    case 'add':
      process.exitCode = await add(rest);
      break;
    case 'work':
      process.exitCode = await work();
      break;
    case 'monitor':
      process.exitCode = await monitor();
      break;
    case 'login':
      process.exitCode = await login(rest);
      break;
    case 'publish':
      process.exitCode = await publish(rest);
      break;
    case 'web':
      process.exitCode = await web();
      break;
    case 'queue':
      process.exitCode = await queue(rest);
      break;
    case 'qa':
      process.exitCode = await qa(rest);
      break;
    case 'prompts':
      process.exitCode = await prompts(rest);
      break;
    case 'hash-password':
      process.exitCode = await hashWebPassword(rest);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      if (command.startsWith('@')) {
        process.exitCode = await campaign([command, ...rest]);
      } else {
        log.error({ command }, 'unknown command');
        process.exitCode = 1;
      }
  }
}

main().catch((err: unknown) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
  process.exitCode = 1;
});
