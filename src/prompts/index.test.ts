import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractVariables, FilesystemPromptStore, interpolate } from './index.js';

describe('extractVariables', () => {
  it('finds distinct placeholders, ignoring whitespace', () => {
    expect(extractVariables('a {{ x }} b {{y}} c {{x}}').sort()).toEqual(['x', 'y']);
  });
});

describe('interpolate', () => {
  it('substitutes variables', () => {
    expect(interpolate('Hi {{name}}, score {{n}}', { name: 'Ada', n: 9 })).toBe('Hi Ada, score 9');
  });
  it('throws when a declared variable is missing', () => {
    expect(() => interpolate('Hi {{name}}', {})).toThrow(/name/);
  });
});

describe('FilesystemPromptStore', () => {
  const dirs: string[] = [];
  async function tempStore(seedDefaults = true) {
    const dir = await mkdtemp(join(tmpdir(), 'clipper-prompts-'));
    dirs.push(dir);
    return { dir, store: new FilesystemPromptStore({ dir, seedDefaults }) };
  }

  afterEach(() => {
    dirs.length = 0; // temp dirs are left for the OS to reap
  });

  it('seeds and lists default prompts', async () => {
    const { store } = await tempStore();
    const list = await store.list();
    expect(list.map((p) => p.name).sort()).toEqual(['clip-caption', 'clip-research']);
  });

  it('renders a seeded prompt with variables', async () => {
    const { store } = await tempStore();
    const rendered = await store.render('clip-caption', { transcript: 'chaos ensued' });
    expect(rendered).toContain('chaos ensued');
  });

  it('selects the latest version numerically', async () => {
    const { dir, store } = await tempStore(false);
    await writeFile(
      join(dir, 'p.v2.json'),
      JSON.stringify({ name: 'p', version: 'v2', template: 'two' }),
    );
    await writeFile(
      join(dir, 'p.v10.json'),
      JSON.stringify({ name: 'p', version: 'v10', template: 'ten' }),
    );
    expect((await store.get('p')).version).toBe('v10');
    expect((await store.get('p', 'v2')).template).toBe('two');
  });

  it('throws for unknown prompt or version', async () => {
    const { store } = await tempStore();
    await expect(store.get('nope')).rejects.toThrow(/not found/);
    await expect(store.get('clip-caption', 'v999')).rejects.toThrow(/not found/);
  });

  it('derives variables from the template when not declared', async () => {
    const { dir, store } = await tempStore(false);
    await writeFile(
      join(dir, 'q.v1.json'),
      JSON.stringify({ name: 'q', version: 'v1', template: 'hi {{who}}' }),
    );
    expect((await store.get('q')).variables).toEqual(['who']);
  });
});
