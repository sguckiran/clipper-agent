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
import { getConfig } from '../config/index.js';
import type { DetectOptions } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import { sourceFromLocalFile } from '../ingest/index.js';
import { dataPaths } from '../core/paths.js';
import { ffmpegBinary, platformInfo, preferredH264Encoder, ytDlpBinary } from '../core/platform.js';
import { FileJobQueue } from '../core/queue.js';
import { ChannelMonitor, YtDlpChannelLister, defaultSeenStore } from '../monitor/index.js';
import { createDefaultPipeline } from '../pipeline/factory.js';
import { FilesystemPromptStore } from '../prompts/index.js';
import { qaTarget } from '../review/index.js';
import { startWebServer } from '../web/index.js';
import { enqueueClipJob, Worker } from '../worker/index.js';

const log = createLogger('cli');

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
  const worker = new Worker(new FileJobQueue(), createDefaultPipeline());
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

function printHelp(): void {
  console.log(
    [
      'clipper-agent',
      '',
      'Usage: clipper <command>',
      '',
      'Commands:',
      '  run <url>     Clip a source now (--limit N, --min-score N)',
      '  add <url>     Enqueue a source URL for the worker',
      '  work          Run the queue worker',
      '  monitor       Poll configured channels and auto-enqueue new VODs',
      '  web           Run the local browser UI (http://localhost:3333)',
      '  queue [status] List queued jobs (pending|running|done|failed)',
      '  qa <file|dir> Review rendered clips: metadata checks + contact sheets',
      '  prompts       List prompts (or: prompts show <name> [version])',
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
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      log.error({ command }, 'unknown command');
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
  process.exitCode = 1;
});
