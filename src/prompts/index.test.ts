import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

  it('seeds and lists default prompts and skills', async () => {
    const { store } = await tempStore();
    const list = await store.list();
    expect(list.map((p) => p.name).sort()).toEqual([
      'clip-caption',
      'clip-caption-style',
      'clip-skill',
    ]);
  });

  it('seeds the clip skill as an editable markdown file', async () => {
    const { dir, store } = await tempStore();
    // Seeding is lazy, so touch the store before inspecting the directory.
    expect((await store.get('clip-skill')).template).toMatch(/## 2\. HOOK/);
    // The skill is markdown on disk so the rating criteria can be retuned without a rebuild.
    expect(await readFile(join(dir, 'clip-skill.v3.md'), 'utf8')).toMatch(/^# Clip skill/);
  });

  it('reads an edited skill back from disk', async () => {
    const { dir, store } = await tempStore();
    await writeFile(join(dir, 'clip-skill.v3.md'), '# my own rules', 'utf8');
    expect((await store.get('clip-skill')).template).toBe('# my own rules');
  });

  it('does not overwrite a skill that already exists on disk', async () => {
    const { dir } = await tempStore();
    await writeFile(join(dir, 'clip-skill.v3.md'), '# tuned by hand', 'utf8');
    // A second store over the same dir must not clobber the user's tuning.
    const second = new FilesystemPromptStore({ dir });
    expect((await second.get('clip-skill')).template).toBe('# tuned by hand');
  });

  it('picks the highest skill version numerically', async () => {
    const { dir, store } = await tempStore();
    await writeFile(join(dir, 'clip-skill.v10.md'), '# v10', 'utf8');
    expect((await store.get('clip-skill')).version).toBe('v10');
    expect((await store.get('clip-skill', 'v3')).template).toMatch(/^# Clip skill/);
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
