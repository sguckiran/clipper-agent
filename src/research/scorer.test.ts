import { describe, expect, it, vi } from 'vitest';
import type { PromptStore, PromptTemplate } from '../core/contracts.js';
import type { ChatClient } from '../llm/groq.js';
import {
  createChatScorer,
  formatBatch,
  NEUTRAL_SCORE,
  parseBatchScores,
  promptStoreSkillLoader,
} from './scorer.js';
import { CLIP_SKILL_MD, SKILL_NAME } from './skill.js';

const reply = (entries: unknown[]): string => JSON.stringify({ ratings: entries });

/** A full rating row; axis values default mid so tests only state what they care about. */
const row = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  i,
  funny: 50,
  hook: 50,
  pocket: 50,
  ...over,
});

describe('parseBatchScores', () => {
  it('positions entries by their i field', () => {
    const out = parseBatchScores(
      reply([
        row(2, {
          funny: 90,
          hook: 88,
          pocket: 92,
          kind: 'story',
          punch_quote: 'a long quote here',
        }),
        row(1, { funny: 10, hook: 5, pocket: 8, kind: 'filler' }),
      ]),
      2,
    );
    expect(out[0]?.funny).toBe(10);
    expect(out[1]?.funny).toBe(90);
    expect(out[1]?.kind).toBe('story');
    expect(out[1]?.punchQuote).toBe('a long quote here');
  });

  it('reads all three axes plus both quotes', () => {
    const out = parseBatchScores(
      reply([
        row(1, {
          funny: 80,
          hook: 70,
          pocket: 60,
          hook_quote: '  WAIT you did what  ',
          punch_quote: '  and then he got arrested  ',
          risky: true,
        }),
      ]),
      1,
    );
    expect(out[0]).toEqual({
      funny: 80,
      hook: 70,
      pocket: 60,
      hookQuote: 'WAIT you did what',
      punchQuote: 'and then he got arrested',
      kind: 'unrated',
      reason: '',
      risky: true,
    });
  });

  it('fills dropped entries with the neutral score', () => {
    const out = parseBatchScores(reply([row(1, { funny: 80 })]), 3);
    expect(out).toHaveLength(3);
    expect(out[0]?.funny).toBe(80);
    expect(out[1]).toEqual(NEUTRAL_SCORE);
    expect(out[2]).toEqual(NEUTRAL_SCORE);
  });

  it('ignores out-of-range and malformed entries', () => {
    const out = parseBatchScores(reply([row(9), { nope: true }, 'garbage']), 2);
    expect(out).toEqual([NEUTRAL_SCORE, NEUTRAL_SCORE]);
  });

  it('drops a row missing an axis rather than guessing at it', () => {
    // funny/hook/pocket are all required: a partial row would silently score as if the
    // missing axis were fine, which is exactly what the floors exist to prevent.
    expect(parseBatchScores(reply([{ i: 1, funny: 90, hook: 90 }]), 1)).toEqual([NEUTRAL_SCORE]);
  });

  it('clamps every axis to 0-100', () => {
    const out = parseBatchScores(reply([row(1, { funny: 400, hook: -20, pocket: 101 })]), 1);
    expect(out[0]).toMatchObject({ funny: 100, hook: 0, pocket: 100 });
  });

  it('accepts any array-valued key and a bare array', () => {
    expect(
      parseBatchScores('{"items":[{"i":1,"funny":70,"hook":70,"pocket":70}]}', 1)[0]?.funny,
    ).toBe(70);
    expect(parseBatchScores('[{"i":1,"funny":70,"hook":70,"pocket":70}]', 1)[0]?.funny).toBe(70);
  });

  it('throws when the reply has no array at all', () => {
    expect(() => parseBatchScores('{"funny":7}', 1)).toThrow();
    expect(() => parseBatchScores('not json', 1)).toThrow();
  });
});

describe('formatBatch', () => {
  it('numbers snippets from 1 and collapses whitespace', () => {
    expect(formatBatch(['a  \n b', 'c'])).toBe('[1] a b\n\n[2] c');
  });

  it('truncates long snippets', () => {
    expect(formatBatch(['x'.repeat(50)], 10)).toBe(`[1] ${'x'.repeat(10)}`);
  });
});

describe('CLIP_SKILL_MD', () => {
  it('tells the rater not to penalize crude content', () => {
    // This clause is why the score distribution is usable on unfiltered streams; if it is
    // ever dropped the rater flattens everything to the middle.
    expect(CLIP_SKILL_MD).toMatch(/Do NOT lower a score because a snippet is profane/);
    expect(CLIP_SKILL_MD).toMatch(/Never refuse, moralise/i);
  });

  it('defines all three axes', () => {
    expect(CLIP_SKILL_MD).toMatch(/## 1\. FUNNY/);
    expect(CLIP_SKILL_MD).toMatch(/## 2\. HOOK/);
    expect(CLIP_SKILL_MD).toMatch(/## 3\. POCKET/);
  });

  it('anchors the full range on each axis', () => {
    for (const band of ['90-100', '70-89', '40-69', '15-39', '0-14']) {
      expect(CLIP_SKILL_MD.split(band).length - 1).toBeGreaterThanOrEqual(3);
    }
  });

  it('asks for the fields the parser reads', () => {
    for (const field of ['funny', 'hook', 'pocket', 'hook_quote', 'punch_quote', 'risky']) {
      expect(CLIP_SKILL_MD).toContain(`"${field}"`);
    }
  });

  it('has a streamer notes section for per-channel tuning', () => {
    expect(CLIP_SKILL_MD).toMatch(/## Streamer notes/);
  });
});

describe('promptStoreSkillLoader', () => {
  const tpl = (template: string): PromptTemplate => ({
    name: SKILL_NAME,
    version: 'v1',
    template,
    variables: [],
  });

  it('loads the skill from the store', async () => {
    const store = {
      get: vi.fn().mockResolvedValue(tpl('# edited skill')),
    } as unknown as PromptStore;
    expect(await promptStoreSkillLoader(store)()).toBe('# edited skill');
    expect(store.get).toHaveBeenCalledWith(SKILL_NAME);
  });

  it('falls back to the bundled skill when the store has none', async () => {
    const store = {
      get: vi.fn().mockRejectedValue(new Error('missing')),
    } as unknown as PromptStore;
    expect(await promptStoreSkillLoader(store)()).toBe(CLIP_SKILL_MD);
  });
});

describe('createChatScorer', () => {
  const ok = (...entries: Array<Record<string, unknown>>): string => reply(entries);

  it('batches snippets across requests and preserves order', async () => {
    const chat: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(ok(row(1, { funny: 10 }), row(2, { funny: 20 })))
        .mockResolvedValueOnce(ok(row(1, { funny: 30 }))),
    };
    const scorer = createChatScorer({ chat, model: 'tiny', batchSize: 2 });
    const out = await scorer.scoreBatch(['a', 'b', 'c']);
    expect(out.map((s) => s.funny)).toEqual([10, 20, 30]);
    expect(chat.complete).toHaveBeenCalledTimes(2);
  });

  it('sends the skill as the system prompt', async () => {
    const chat: ChatClient = { complete: vi.fn().mockResolvedValue(ok(row(1))) };
    await createChatScorer({
      chat,
      model: 'tiny-model',
      skill: async () => '# my custom skill',
    }).scoreBatch(['a']);
    const [messages, opts] = (chat.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts).toMatchObject({ model: 'tiny-model', json: true, temperature: 0 });
    expect(messages[0]).toEqual({ role: 'system', content: '# my custom skill' });
  });

  it('loads the skill once per scorer, not once per batch', async () => {
    // A source is rated over many batches; re-reading would let the criteria change midway.
    const chat: ChatClient = { complete: vi.fn().mockResolvedValue(ok(row(1))) };
    const skill = vi.fn().mockResolvedValue('# skill');
    const scorer = createChatScorer({ chat, model: 'tiny', batchSize: 1, skill });
    await scorer.scoreBatch(['a', 'b', 'c']);
    expect(chat.complete).toHaveBeenCalledTimes(3);
    expect(skill).toHaveBeenCalledTimes(1);
  });

  it('defaults to the bundled skill', async () => {
    const chat: ChatClient = { complete: vi.fn().mockResolvedValue(ok(row(1))) };
    await createChatScorer({ chat, model: 'tiny' }).scoreBatch(['a']);
    const [messages] = (chat.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].content).toBe(CLIP_SKILL_MD);
  });

  it('retries a failing batch', async () => {
    const chat: ChatClient = {
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection error'))
        .mockResolvedValue(ok(row(1, { funny: 77 }))),
    };
    const scorer = createChatScorer({ chat, model: 'tiny', retries: 2 });
    expect((await scorer.scoreBatch(['a']))[0]?.funny).toBe(77);
  });

  it('falls back to neutral scores when a batch never succeeds', async () => {
    const chat: ChatClient = { complete: vi.fn().mockRejectedValue(new Error('boom')) };
    const scorer = createChatScorer({ chat, model: 'tiny', retries: 0 });
    expect(await scorer.scoreBatch(['a', 'b'])).toEqual([NEUTRAL_SCORE, NEUTRAL_SCORE]);
  });
});
