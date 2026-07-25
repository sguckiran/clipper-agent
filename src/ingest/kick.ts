/**
 * Kick VOD resolver.
 *
 * Kick plays VODs through the Amazon IVS WASM player, which fetches media inside a
 * Web Worker and only exposes a *signed, short-lived* CloudFront master playlist
 * (`…/master.m3u8?aws.sessionId=…`). yt-dlp and kick-dl can't mint that signature,
 * so the only reliable way to get a downloadable URL is to open the page in a real
 * browser and capture the request the player makes.
 *
 * This drives headless Chrome via playwright-core (loaded lazily, so it's only
 * needed when actually resolving a Kick URL) and returns the signed playlist URL,
 * which the normal yt-dlp/ffmpeg path can then download before the token expires.
 */
import type { Browser } from 'playwright-core';
import { createLogger } from '../core/logger.js';

const log = createLogger('ingest:kick');

/** True for a Kick VOD page URL (kick.com/<channel>/videos/<uuid>). */
export function isKickVodUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().endsWith('kick.com') && u.pathname.includes('/videos/');
  } catch {
    return false;
  }
}

/**
 * Choose the downloadable master playlist from the URLs a page requested.
 * Prefers a signed CloudFront `master.m3u8`, then any `master.m3u8`, then any m3u8.
 */
export function pickMasterPlaylist(urls: string[]): string | undefined {
  const masters = urls.filter((u) => /\/master\.m3u8(\?|$)/i.test(u));
  const signed = masters.find((u) => u.includes('cloudfront.net') || u.includes('aws.sessionId'));
  return signed ?? masters[0] ?? urls.find((u) => u.includes('.m3u8'));
}

export interface KickResolveOptions {
  /** Overall time budget to capture the playlist. */
  timeoutMs?: number;
  /** Run the browser headless (default true). */
  headless?: boolean;
  /** Chrome channel for playwright-core (default 'chrome'; uses the system install). */
  channel?: string;
}

/**
 * Open a Kick VOD in headless Chrome and capture the signed master playlist URL.
 * Throws if no media playlist is seen within the timeout.
 */
export async function resolveKickVodUrl(
  pageUrl: string,
  opts: KickResolveOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const { chromium } = await import('playwright-core');
  const urls: string[] = [];
  let browser: Browser | undefined;
  log.info({ url: pageUrl }, 'resolving Kick VOD via headless browser');
  try {
    // The IVS player refuses to autoplay when it detects automation, so mask
    // navigator.webdriver and allow gesture-free autoplay — without this, no media
    // request is ever made and nothing can be captured.
    browser = await chromium.launch({
      headless: opts.headless ?? true,
      channel: opts.channel ?? 'chrome',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
      ],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    });
    // Browser-context snippets are passed as strings so they don't need the DOM lib
    // (this is a Node project). Mask webdriver so the IVS player will autoplay.
    await context.addInitScript(
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
    );
    const page = await context.newPage();
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Nudge playback in case autoplay still doesn't kick in.
    await page
      .evaluate(
        "(() => { const v = document.querySelector('video'); if (v) { v.muted = true; const r = v.play && v.play(); if (r && r.catch) r.catch(() => {}); } })()",
      )
      .catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let master: string | undefined;
    while (Date.now() < deadline) {
      master = pickMasterPlaylist(urls);
      if (master) break;
      await page.waitForTimeout(500);
    }
    if (!master) {
      throw new Error('could not capture Kick media playlist (no .m3u8 request seen in time)');
    }
    log.info({ master }, 'captured signed Kick playlist');
    return master;
  } finally {
    await browser?.close();
  }
}
