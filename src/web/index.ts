#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { createLogger } from '../core/logger.js';
import type { Clip, ClipCandidate } from '../core/types.js';
import { createDefaultPipeline } from '../pipeline/factory.js';
import type { LayoutMode, PanelRect } from '../render/index.js';

const log = createLogger('web');

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface WebClip {
  id: string;
  candidateId: string;
  sourceId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  caption: string;
  renderedPath?: string;
  mediaUrl?: string;
  score: number;
  quality: number;
  funny?: number;
  hook?: number;
  pocket?: number;
  coherence?: number;
  reason?: string;
  kind?: string;
  quote?: string;
  hookQuote?: string;
  unpostable?: boolean;
}

export interface WebJob {
  id: string;
  url: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  limit: number;
  minScore: number;
  layout: LayoutMode;
  message: string;
  error?: string;
  clips: WebClip[];
}

const jobs = new Map<string, WebJob>();
let queue: Promise<void> = Promise.resolve();

const KRIMOE_OMEGLE_PANELS: PanelRect[] = [
  { x: 34, y: 74, w: 600, h: 448 },
  { x: 634, y: 74, w: 600, h: 448 },
];

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)));
}

function axis(candidate: ClipCandidate | undefined, key: 'funny' | 'hook' | 'coherence'): number {
  return clampScore(candidate?.[key] ?? 0);
}

/**
 * One strict review meter for the UI.
 *
 * This is deliberately an AND gate: the final meter is capped by the weakest required
 * dimension, so a funny clip that makes no sense ranks badly, and a coherent clip that is
 * not funny also ranks badly.
 */
export function qualityMeter(candidate: ClipCandidate | undefined): number {
  if (!candidate) return 0;
  return Math.min(
    clampScore(candidate.score),
    axis(candidate, 'funny'),
    axis(candidate, 'hook'),
    axis(candidate, 'coherence'),
  );
}

function toWebClip(jobId: string, clip: Clip): WebClip {
  const candidate = clip.candidate;
  const durationSec = Math.max(0, clip.endSec - clip.startSec);
  return {
    id: clip.id,
    candidateId: clip.candidateId,
    sourceId: clip.sourceId,
    startSec: Number(clip.startSec.toFixed(1)),
    endSec: Number(clip.endSec.toFixed(1)),
    durationSec: Number(durationSec.toFixed(1)),
    caption: clip.caption.text,
    renderedPath: clip.renderedPath,
    mediaUrl: clip.renderedPath
      ? `/api/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clip.candidateId)}/video`
      : undefined,
    score: clampScore(candidate?.score ?? 0),
    quality: qualityMeter(candidate),
    funny: candidate?.funny,
    hook: candidate?.hook,
    pocket: candidate?.pocket,
    coherence: candidate?.coherence,
    reason: candidate?.reason,
    kind: candidate?.kind,
    quote: candidate?.quote,
    hookQuote: candidate?.hookQuote,
    unpostable: candidate?.unpostable,
  };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res: ServerResponse, status: number, body: string, contentType = 'text/plain'): void {
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((acc, c) => acc + c.length, 0) > 64 * 1024) {
      throw new Error('Request body too large');
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function publicJob(job: WebJob): WebJob {
  return {
    ...job,
    clips: [...job.clips].sort((a, b) => b.quality - a.quality || b.score - a.score),
  };
}

async function runJob(job: WebJob): Promise<void> {
  job.status = 'running';
  job.message = 'Downloading, transcribing, scoring and rendering clips...';
  job.updatedAt = new Date().toISOString();
  try {
    const cfg = getConfig();
    const pipeline = createDefaultPipeline({
      renderer:
        job.layout === 'auto'
          ? {
              layout: 'auto',
              panels: cfg.render.panels.length > 0 ? cfg.render.panels : KRIMOE_OMEGLE_PANELS,
            }
          : undefined,
    });
    const result = await pipeline.run(job.url, { limit: job.limit, minScore: job.minScore });
    const rendered = result.clips.map((clip) => toWebClip(job.id, clip));
    job.clips = rendered.filter((clip) => clip.quality >= job.minScore);
    job.status = 'done';
    job.message =
      job.clips.length === 0
        ? 'Done, but no clips cleared the AND-gated score threshold.'
        : `Done. Rendered ${rendered.length} clips; ${job.clips.length} cleared the quality gate.`;
    job.updatedAt = new Date().toISOString();
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.message = 'Failed. Check the error and terminal logs.';
    job.updatedAt = new Date().toISOString();
    log.error({ err: job.error, jobId: job.id }, 'web job failed');
  }
}

function enqueue(job: WebJob): void {
  queue = queue.then(() => runJob(job), () => runJob(job));
}

function findClip(job: WebJob, candidateId: string): WebClip | undefined {
  return job.clips.find((clip) => clip.candidateId === candidateId);
}

async function serveClip(job: WebJob, candidateId: string, res: ServerResponse): Promise<void> {
  const clip = findClip(job, candidateId);
  if (!clip?.renderedPath) {
    json(res, 404, { error: 'Clip not found' });
    return;
  }
  const info = await stat(clip.renderedPath);
  const ext = extname(clip.renderedPath).toLowerCase();
  const contentType = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    'accept-ranges': 'bytes',
  });
  createReadStream(clip.renderedPath).pipe(res);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method === 'GET' && pathname === '/api/jobs') {
    json(res, 200, { jobs: [...jobs.values()].map(publicJob).reverse() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    const body = (await readJson(req)) as Record<string, unknown>;
    const url = String(body.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      json(res, 400, { error: 'Paste a valid Kick, Twitch or YouTube URL' });
      return;
    }
    const cfg = getConfig();
    const autoOmegle = body.autoOmegle === true || body.autoOmegle === 'true';
    const job: WebJob = {
      id: randomUUID(),
      url,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      limit: asNumber(body.limit, Math.max(30, cfg.scoring.maxCandidates), 1, 100),
      minScore: asNumber(body.minScore, cfg.scoring.minScore, 0, 100),
      layout: autoOmegle ? 'auto' : cfg.render.layout,
      message: 'Queued. Waiting for the current job to finish...',
      clips: [],
    };
    jobs.set(job.id, job);
    enqueue(job);
    json(res, 202, publicJob(job));
    return;
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (req.method === 'GET' && jobMatch?.[1]) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) {
      json(res, 404, { error: 'Job not found' });
      return;
    }
    json(res, 200, publicJob(job));
    return;
  }

  const clipMatch = /^\/api\/jobs\/([^/]+)\/clips\/([^/]+)\/video$/.exec(pathname);
  if (req.method === 'GET' && clipMatch?.[1] && clipMatch[2]) {
    const job = jobs.get(decodeURIComponent(clipMatch[1]));
    if (!job) {
      json(res, 404, { error: 'Job not found' });
      return;
    }
    await serveClip(job, decodeURIComponent(clipMatch[2]), res);
    return;
  }

  json(res, 404, { error: 'Not found' });
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clipper Agent</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, Arial, sans-serif; }
    body { margin: 0; background: #08090d; color: #f5f7fb; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 32px auto 64px; }
    h1 { margin: 0 0 6px; font-size: clamp(32px, 6vw, 64px); letter-spacing: -0.06em; }
    p { color: #aeb6c7; line-height: 1.5; }
    form { display: grid; grid-template-columns: 1fr 120px 130px 190px auto; gap: 10px; margin: 28px 0; }
    input, button { border: 1px solid #2a3040; border-radius: 14px; padding: 14px 16px; font: inherit; }
    input { background: #11141c; color: #fff; }
    button { background: #f4e500; color: #090909; font-weight: 800; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    .check { display: flex; align-items: center; gap: 8px; color: #dce3f4; background: #11141c; border: 1px solid #2a3040; border-radius: 14px; padding: 10px 12px; }
    .check input { width: 18px; height: 18px; }
    .panel { background: linear-gradient(180deg, #121621, #0e1118); border: 1px solid #252b38; border-radius: 22px; padding: 18px; }
    .status { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .pill { border-radius: 999px; padding: 7px 11px; background: #232a38; color: #dce3f4; font-size: 13px; font-weight: 800; text-transform: uppercase; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; }
    .card { overflow: hidden; border: 1px solid #252b38; border-radius: 20px; background: #10131b; }
    video { width: 100%; aspect-ratio: 9/16; display: block; background: #000; object-fit: contain; }
    .body { padding: 14px; }
    .topline { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    .rank { color: #f4e500; font-weight: 900; }
    .meter { height: 12px; border-radius: 999px; background: #252b38; overflow: hidden; margin: 10px 0; }
    .fill { height: 100%; width: 0%; background: linear-gradient(90deg, #ff4444, #ffd000, #39ff88); }
    .scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
    .score { background: #171c27; border-radius: 12px; padding: 8px; color: #aeb6c7; font-size: 12px; }
    .score strong { display: block; color: #fff; font-size: 16px; }
    .caption { color: #fff; font-weight: 800; margin: 10px 0 4px; }
    .meta { font-size: 13px; color: #aeb6c7; }
    .path { font-size: 12px; color: #7f8aa3; overflow-wrap: anywhere; }
    .hidden { display: none; }
    @media (max-width: 760px) { form { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Clipper Agent</h1>
    <p>Paste a Kick, Twitch or YouTube link. The backend downloads, transcribes, finds as many good clips as requested, then ranks them with one strict meter: virality AND coherence.</p>
    <form id="form">
      <input id="url" required placeholder="https://www.youtube.com/watch?v=..." />
      <input id="limit" type="number" min="1" max="100" value="30" title="Max clips" />
      <input id="minScore" type="number" min="0" max="100" value="55" title="Minimum score" />
      <label class="check"><input id="autoOmegle" type="checkbox" checked /> Auto Omegle split</label>
      <button id="submit">Clip it</button>
    </form>
    <section class="panel">
      <div class="status">
        <div>
          <div id="message">No job running.</div>
          <div id="sub" class="meta">Quality = min(overall virality, funny, hook, coherence). Low coherence caps the clip.</div>
        </div>
        <div id="state" class="pill">idle</div>
      </div>
      <div id="clips" class="grid"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector('#form');
    const url = document.querySelector('#url');
    const limit = document.querySelector('#limit');
    const minScore = document.querySelector('#minScore');
    const autoOmegle = document.querySelector('#autoOmegle');
    const submit = document.querySelector('#submit');
    const message = document.querySelector('#message');
    const sub = document.querySelector('#sub');
    const state = document.querySelector('#state');
    const clips = document.querySelector('#clips');
    let timer;

    function setStatus(job) {
      state.textContent = job ? job.status : 'idle';
      message.textContent = job ? job.message : 'No job running.';
      sub.textContent = job
        ? job.clips.length + ' clips · limit ' + job.limit + ' · minimum score ' + job.minScore + ' · layout ' + job.layout
        : 'Quality = min(overall virality, funny, hook, coherence). Low coherence caps the clip.';
      submit.disabled = job && (job.status === 'queued' || job.status === 'running');
    }

    function scoreBox(label, value) {
      const div = document.createElement('div');
      div.className = 'score';
      const strong = document.createElement('strong');
      strong.textContent = value ?? '—';
      div.append(strong, label);
      return div;
    }

    function render(job) {
      setStatus(job);
      clips.replaceChildren();
      job.clips.forEach((clip, index) => {
        const card = document.createElement('article');
        card.className = 'card';
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        if (clip.mediaUrl) video.src = clip.mediaUrl;
        const body = document.createElement('div');
        body.className = 'body';
        const top = document.createElement('div');
        top.className = 'topline';
      const rank = document.createElement('div');
      rank.className = 'rank';
      rank.textContent = '#' + (index + 1);
      const q = document.createElement('div');
      q.textContent = 'Quality ' + clip.quality;
        top.append(rank, q);
        const meter = document.createElement('div');
        meter.className = 'meter';
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.width = clip.quality + '%';
        meter.append(fill);
        const scores = document.createElement('div');
        scores.className = 'scores';
        scores.append(
          scoreBox('viral', clip.score),
          scoreBox('funny', clip.funny),
          scoreBox('hook', clip.hook),
          scoreBox('flow', clip.coherence),
        );
        const cap = document.createElement('div');
        cap.className = 'caption';
        cap.textContent = clip.caption || clip.reason || clip.kind || 'Untitled clip';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent =
        clip.durationSec + 's · ' + (clip.kind || 'clip') + (clip.unpostable ? ' · risky' : '');
        const path = document.createElement('div');
        path.className = 'path';
        path.textContent = clip.renderedPath || '';
        body.append(top, meter, scores, cap, meta, path);
        card.append(video, body);
        clips.append(card);
      });
    }

    async function poll(id) {
      const res = await fetch('/api/jobs/' + encodeURIComponent(id));
      const job = await res.json();
      render(job);
      if (job.status === 'queued' || job.status === 'running') {
        timer = setTimeout(() => poll(id), 2500);
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearTimeout(timer);
      setStatus({ status: 'queued', message: 'Submitting job...', clips: [], limit: limit.value, minScore: minScore.value, layout: autoOmegle.checked ? 'auto' : 'fill' });
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: url.value,
          limit: limit.value,
          minScore: minScore.value,
          autoOmegle: autoOmegle.checked,
        }),
      });
      const job = await res.json();
      if (!res.ok) {
        setStatus({ status: 'failed', message: job.error || 'Failed to submit job', clips: [], limit: limit.value, minScore: minScore.value, layout: autoOmegle.checked ? 'auto' : 'fill' });
        return;
      }
      render(job);
      poll(job.id);
    });
  </script>
</body>
</html>`;

export function createWebServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        text(res, 200, html, 'text/html');
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url.pathname);
        return;
      }
      text(res, 404, 'Not found');
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'web request failed');
      if (!res.headersSent) json(res, 500, { error: message });
      else res.end();
    });
  });
}

export function startWebServer(port = Number(process.env.CLIPPER_WEB_PORT ?? 3333)): Server {
  const server = createWebServer();
  server.listen(port, () => {
    log.info({ url: `http://localhost:${port}` }, 'web UI ready');
  });
  return server;
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) startWebServer();
