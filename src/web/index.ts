#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
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
  descriptions?: Clip['caption']['descriptions'];
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
const SESSION_COOKIE = 'clipper_session';
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

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
    descriptions: clip.caption.descriptions,
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

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function sessionSecret(): string {
  const cfg = getConfig();
  return (
    cfg.web.sessionSecret ??
    cfg.web.passwordHash ??
    cfg.web.password ??
    'clipper-local-dev-session-secret'
  );
}

function cookieSecure(req: IncomingMessage): boolean {
  const cfg = getConfig();
  return cfg.web.cookieSecure || req.headers['x-forwarded-proto'] === 'https';
}

function authEnabled(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.web.password || cfg.web.passwordHash);
}

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(password, salt, 64);
  return `scrypt:v1:${base64url(salt)}:${base64url(hash)}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [scheme, version, saltRaw, hashRaw] = encoded.split(':');
  if (scheme !== 'scrypt' || version !== 'v1' || !saltRaw || !hashRaw) return false;
  const expected = fromBase64url(hashRaw);
  const actual = scryptSync(password, fromBase64url(saltRaw), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function passwordMatches(password: string): boolean {
  const cfg = getConfig();
  if (cfg.web.passwordHash) return verifyPassword(password, cfg.web.passwordHash);
  if (!cfg.web.password) return false;
  const actual = Buffer.from(password);
  const expected = Buffer.from(cfg.web.password);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionKey(): Buffer {
  return createHash('sha256').update(sessionSecret()).digest();
}

function sealSession(now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv);
  const plaintext = Buffer.from(
    JSON.stringify({
      iat: now,
      exp: now + SESSION_TTL_SEC * 1000,
      nonce: randomUUID(),
    }),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', base64url(iv), base64url(ciphertext), base64url(tag)].join('.');
}

function openSession(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const [version, ivRaw, ciphertextRaw, tagRaw] = value.split('.');
  if (version !== 'v1' || !ivRaw || !ciphertextRaw || !tagRaw) return false;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(), fromBase64url(ivRaw));
    decipher.setAuthTag(fromBase64url(tagRaw));
    const plaintext = Buffer.concat([
      decipher.update(fromBase64url(ciphertextRaw)),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as { exp?: unknown };
    return typeof parsed.exp === 'number' && parsed.exp > now;
  } catch {
    return false;
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    out[name] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function isAuthed(req: IncomingMessage): boolean {
  if (!authEnabled()) return true;
  return openSession(parseCookies(req)[SESSION_COOKIE]);
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(sealSession())}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (cookieSecure(req)) attrs.push('Secure');
  res.setHeader('set-cookie', attrs.join('; '));
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total > 64 * 1024) throw new Error('Request body too large');
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
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
  queue = queue.then(
    () => runJob(job),
    () => runJob(job),
  );
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

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
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

async function loginPassword(req: IncomingMessage): Promise<string> {
  const raw = await readBody(req);
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return String(parsed.password ?? '');
  }
  const form = new URLSearchParams(raw);
  return form.get('password') ?? '';
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authEnabled()) {
    redirect(res, '/');
    return;
  }
  const password = await loginPassword(req);
  if (!passwordMatches(password)) {
    text(res, 401, loginHtml('Wrong password.'), 'text/html');
    return;
  }
  setSessionCookie(req, res);
  redirect(res, '/');
}

const loginHtml = (error = '') => String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clipper Agent Login</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, Arial, sans-serif; }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh; margin: 0; display: grid; place-items: center; color: #f8fafc;
      background:
        radial-gradient(circle at 20% 10%, rgba(244,229,0,.22), transparent 26rem),
        radial-gradient(circle at 90% 15%, rgba(104,58,255,.28), transparent 32rem),
        linear-gradient(135deg, #07080c 0%, #10131d 48%, #07080c 100%);
    }
    .card {
      width: min(430px, calc(100vw - 32px)); padding: 28px; border: 1px solid rgba(255,255,255,.12);
      border-radius: 28px; background: rgba(10,12,18,.72); box-shadow: 0 28px 80px rgba(0,0,0,.45);
      backdrop-filter: blur(18px);
    }
    .badge { display: inline-flex; gap: 8px; align-items: center; color: #f4e500; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }
    h1 { margin: 18px 0 8px; font-size: 40px; line-height: .95; letter-spacing: -.06em; }
    p { margin: 0 0 24px; color: #aeb6c7; line-height: 1.5; }
    label { display: block; color: #d9e1f2; font-size: 13px; font-weight: 800; margin-bottom: 8px; }
    input, button { width: 100%; border: 1px solid rgba(255,255,255,.14); border-radius: 16px; padding: 15px 16px; font: inherit; }
    input { color: #fff; background: rgba(255,255,255,.06); outline: none; }
    input:focus { border-color: #f4e500; box-shadow: 0 0 0 4px rgba(244,229,0,.12); }
    button { margin-top: 12px; color: #08090d; background: #f4e500; font-weight: 950; cursor: pointer; }
    .error { margin: 0 0 14px; padding: 10px 12px; border-radius: 12px; color: #fecaca; background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.35); }
    .hint { margin-top: 18px; font-size: 12px; color: #7f8aa3; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="badge">● Protected build</div>
    <h1>Clipper Agent</h1>
    <p>Private clipping dashboard. Enter the deployment password to continue.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <button type="submit">Unlock dashboard</button>
    <div class="hint">Use HTTPS on Hetzner so the password is encrypted in transit.</div>
  </form>
</body>
</html>`;

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clipper Agent</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, Arial, sans-serif;
      --bg: #07080c; --panel: rgba(16,19,29,.78); --line: rgba(255,255,255,.12);
      --muted: #98a3b8; --text: #f8fafc; --yellow: #f4e500; --green: #39ff88;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; background:
        radial-gradient(circle at 16% 2%, rgba(244,229,0,.18), transparent 28rem),
        radial-gradient(circle at 88% 8%, rgba(92,70,255,.24), transparent 30rem),
        linear-gradient(180deg, #090a10 0%, #07080c 50%, #05060a 100%);
      color: var(--text);
    }
    main { width: min(1240px, calc(100vw - 32px)); margin: 26px auto 72px; }
    .nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; color: var(--muted); }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 950; letter-spacing: -.03em; color: #fff; }
    .logo { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 12px; color: #08090d; background: var(--yellow); box-shadow: 0 0 34px rgba(244,229,0,.28); }
    .logout { display: inline; margin: 0; }
    .logout button { padding: 9px 12px; border-radius: 999px; color: #dce3f4; background: rgba(255,255,255,.06); border: 1px solid var(--line); }
    .hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 22px; align-items: stretch; margin-bottom: 22px; }
    .heroCard, .panel, .controlCard {
      border: 1px solid var(--line); border-radius: 30px; background: var(--panel);
      box-shadow: 0 24px 80px rgba(0,0,0,.34); backdrop-filter: blur(18px);
    }
    .heroCard { padding: clamp(24px, 4vw, 44px); overflow: hidden; position: relative; }
    .heroCard:after { content: ""; position: absolute; inset: auto -80px -120px auto; width: 280px; height: 280px; border-radius: 50%; background: rgba(244,229,0,.13); filter: blur(10px); }
    .eyebrow { color: var(--yellow); font-size: 12px; font-weight: 950; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 12px 0 12px; font-size: clamp(42px, 7vw, 86px); line-height: .86; letter-spacing: -0.075em; max-width: 780px; }
    p { color: var(--muted); line-height: 1.55; margin: 0; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 26px; }
    .stat { padding: 14px; border: 1px solid var(--line); border-radius: 18px; background: rgba(255,255,255,.045); }
    .stat strong { display: block; color: #fff; font-size: 24px; }
    .controlCard { padding: 18px; }
    form#form { display: grid; gap: 12px; margin: 0; }
    .field { display: grid; gap: 7px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    label, .label { color: #dce3f4; font-size: 12px; font-weight: 900; letter-spacing: .04em; text-transform: uppercase; }
    input, button { border: 1px solid var(--line); border-radius: 16px; padding: 14px 15px; font: inherit; }
    input { background: rgba(255,255,255,.055); color: #fff; outline: none; }
    input:focus { border-color: var(--yellow); box-shadow: 0 0 0 4px rgba(244,229,0,.10); }
    button { background: var(--yellow); color: #090909; font-weight: 950; cursor: pointer; transition: transform .16s ease, opacity .16s ease; }
    button:hover { transform: translateY(-1px); }
    button:disabled { opacity: .55; cursor: wait; transform: none; }
    .check { display: flex; align-items: center; gap: 8px; color: #dce3f4; background: rgba(255,255,255,.055); border: 1px solid var(--line); border-radius: 16px; padding: 13px 14px; }
    .check input { width: 18px; height: 18px; }
    .panel { padding: 18px; }
    .status { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 20px; padding: 14px; border-radius: 20px; background: rgba(255,255,255,.045); border: 1px solid var(--line); }
    .pill { border-radius: 999px; padding: 8px 12px; background: rgba(244,229,0,.12); color: var(--yellow); font-size: 12px; font-weight: 950; text-transform: uppercase; border: 1px solid rgba(244,229,0,.25); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(286px, 1fr)); gap: 18px; }
    .card { overflow: hidden; border: 1px solid var(--line); border-radius: 24px; background: rgba(10,12,18,.88); box-shadow: 0 18px 50px rgba(0,0,0,.28); }
    video { width: 100%; aspect-ratio: 9/16; display: block; background: #000; object-fit: contain; }
    .body { padding: 15px; }
    .topline { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    .rank { color: var(--yellow); font-weight: 950; }
    .quality { color: #fff; font-weight: 900; }
    .meter { height: 12px; border-radius: 999px; background: #252b38; overflow: hidden; margin: 12px 0; }
    .fill { height: 100%; width: 0%; background: linear-gradient(90deg, #ff4444, #ffd000, var(--green)); }
    .scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
    .score { background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.07); border-radius: 14px; padding: 9px; color: var(--muted); font-size: 12px; }
    .score strong { display: block; color: #fff; font-size: 16px; }
    .caption { color: #fff; font-weight: 900; margin: 10px 0 5px; letter-spacing: -.01em; }
    .description { margin-top: 10px; padding: 10px; border-radius: 14px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.07); color: #dfe6f8; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .description strong { display: block; color: var(--yellow); font-size: 11px; text-transform: uppercase; margin-bottom: 4px; }
    .meta { font-size: 13px; color: var(--muted); }
    .path { font-size: 12px; color: #7f8aa3; overflow-wrap: anywhere; margin-top: 8px; }
    .hidden { display: none; }
    @media (max-width: 860px) { .hero { grid-template-columns: 1fr; } .stats, .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="nav">
      <div class="brand"><div class="logo">▶</div>Clipper Agent</div>
      <form class="logout" method="post" action="/logout"><button type="submit">Lock</button></form>
    </div>
    <section class="hero">
      <div class="heroCard">
        <div class="eyebrow">Livestream to ranked shorts</div>
        <h1>Find the moments worth posting.</h1>
        <p>Paste a Kick, Twitch or YouTube link. The backend downloads, transcribes, filters for coherent funny clips, auto-detects Omegle layouts, then renders subtitled vertical videos.</p>
        <div class="stats">
          <div class="stat"><strong>AND</strong> virality + coherence</div>
          <div class="stat"><strong>Auto</strong> Omegle split</div>
          <div class="stat"><strong>9:16</strong> rendered clips</div>
        </div>
      </div>
      <div class="controlCard">
        <form id="form">
          <div class="field">
            <label for="url">Source link</label>
            <input id="url" required placeholder="https://www.youtube.com/watch?v=..." />
          </div>
          <div class="row">
            <div class="field">
              <label for="limit">Max clips</label>
              <input id="limit" type="number" min="1" max="100" value="30" />
            </div>
            <div class="field">
              <label for="minScore">Minimum score</label>
              <input id="minScore" type="number" min="0" max="100" value="55" />
            </div>
          </div>
          <label class="check"><input id="autoOmegle" type="checkbox" checked /> Auto Omegle split</label>
          <button id="submit">Clip it</button>
        </form>
      </div>
    </section>
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
      q.className = 'quality';
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
        const descriptions = document.createElement('div');
        if (clip.descriptions?.tiktok) {
          const tiktok = document.createElement('div');
          tiktok.className = 'description';
          const label = document.createElement('strong');
          label.textContent = 'TikTok description';
          tiktok.append(label, clip.descriptions.tiktok);
          descriptions.append(tiktok);
        }
        if (clip.descriptions?.instagram) {
          const instagram = document.createElement('div');
          instagram.className = 'description';
          const label = document.createElement('strong');
          label.textContent = 'Instagram description';
          instagram.append(label, clip.descriptions.instagram);
          descriptions.append(instagram);
        }
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent =
        clip.durationSec + 's · ' + (clip.kind || 'clip') + (clip.unpostable ? ' · risky' : '');
        const path = document.createElement('div');
        path.className = 'path';
        path.textContent = clip.renderedPath || '';
        body.append(top, meter, scores, cap, descriptions, meta, path);
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
      if (url.pathname === '/login') {
        if (req.method === 'GET') {
          if (isAuthed(req)) redirect(res, '/');
          else text(res, 200, loginHtml(), 'text/html');
          return;
        }
        if (req.method === 'POST') {
          await handleLogin(req, res);
          return;
        }
      }
      if (url.pathname === '/logout' && req.method === 'POST') {
        clearSessionCookie(res);
        redirect(res, '/login');
        return;
      }
      if (!isAuthed(req)) {
        if (url.pathname.startsWith('/api/')) {
          json(res, 401, { error: 'Authentication required' });
          return;
        }
        redirect(res, '/login');
        return;
      }
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
