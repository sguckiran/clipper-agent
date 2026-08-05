import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../config/index.js';
import { BrowserPublisher, defaultPublisherScriptPath, resolvePythonCommand } from './browser.js';

const MANAGED_KEYS = ['CLIPPER_DATA_DIR', 'CLIPPER_PUBLISH_PLATFORMS', 'CLIPPER_CREATOR_HANDLE'];

describe('BrowserPublisher', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetConfigCache();
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigCache();
  });

  it('points at the in-repo Python bridge by default', () => {
    expect(defaultPublisherScriptPath()).toMatch(
      /python[\\/]clipper_publisher[\\/]browser_publisher\.py$/,
    );
  });

  it('supports Python launcher commands with arguments', () => {
    expect(resolvePythonCommand('py -3')).toEqual({ bin: 'py', args: ['-3'] });
    expect(resolvePythonCommand('"C:\\Program Files\\Python312\\python.exe"')).toEqual({
      bin: 'C:\\Program Files\\Python312\\python.exe',
      args: [],
    });
  });

  it('sends a publish request to the bridge and parses results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clipper-publisher-'));
    const fakeScript = join(dir, 'fake-publisher.mjs');
    await writeFile(
      fakeScript,
      [
        "import { stdin } from 'node:process';",
        "let raw = '';",
        'for await (const chunk of stdin) raw += chunk;',
        'const payload = JSON.parse(raw);',
        'console.log(JSON.stringify({ ok: true, results: payload.platforms.map((p) => ({ platform: p, status: "published" })) }));',
      ].join('\n'),
      'utf8',
    );

    const publisher = new BrowserPublisher({
      python: process.execPath,
      scriptPath: fakeScript,
      dataDir: dir,
    });

    const response = await publisher.publishFile('C:\\clips\\one.mp4', 'caption', ['tiktok']);

    expect(response).toEqual({
      ok: true,
      results: [{ platform: 'tiktok', status: 'published' }],
    });
  });

  it('adds creator attribution to direct publish captions when configured', async () => {
    process.env.CLIPPER_CREATOR_HANDLE = '@krimoemp4';
    resetConfigCache();
    const dir = await mkdtemp(join(tmpdir(), 'clipper-publisher-'));
    const fakeScript = join(dir, 'fake-publisher.mjs');
    await writeFile(
      fakeScript,
      [
        "import { stdin } from 'node:process';",
        "let raw = '';",
        'for await (const chunk of stdin) raw += chunk;',
        'const payload = JSON.parse(raw);',
        'console.log(JSON.stringify({ ok: true, results: [{ platform: "tiktok", status: "published", caption: payload.caption }] }));',
      ].join('\n'),
      'utf8',
    );

    const publisher = new BrowserPublisher({
      python: process.execPath,
      scriptPath: fakeScript,
      dataDir: dir,
    });

    const response = await publisher.publishFile('C:\\clips\\one.mp4', 'watch this', ['tiktok']);

    expect(response.results[0]).toMatchObject({
      caption: 'watch this\n\nCredit: @krimoemp4',
    });
  });
});
