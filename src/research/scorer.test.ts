import { describe, expect, it, vi } from 'vitest';
import type { ChatClient } from '../llm/groq.js';
import {
  createChatScorer,
  formatBatch,
  NEUTRAL_SCORE,
  parseBatchScores,
  SCORER_SYSTEM,
} from './scorer.js';

const reply = (entries: unknown[]): string => JSON.stringify({ ratings: entries });

describe('parseBatchScores', () => {
  it('positions entries by their i field', () => {
    const out = parseBatchScores(
      reply([
        { i: 2, score: 90, kind: 'story', quote: 'a very long quote here', reason: 'wild' },
        { i: 1, score: 10, kind: 'filler', quote: '', reason: 'sponsor read' },
      ]),
      2,
    );
    expect(out[0]?.score).toBe(10);
    expect(out[1]?.score).toBe(90);
    expect(out[1]?.kind).toBe('story');
  });

  it('fills dropped entries with the neutral score', () => {
    const out = parseBatchScores(reply([{ i: 1, score: 80 }]), 3);
    expect(out).toHaveLength(3);
    expect(out[0]?.score).toBe(80);
    expect(out[1]).toEqual(NEUTRAL_SCORE);
    expect(out[2]).toEqual(NEUTRAL_SCORE);
  });

  it('ignores out-of-range and malformed entries', () => {
    const out = parseBatchScores(reply([{ i: 9, score: 80 }, { nope: true }, 'garbage']), 2);
    expect(out).toEqual([NEUTRAL_SCORE, NEUTRAL_SCORE]);
  });

  it('clamps scores to 0-100', () => {
    const out = parseBatchScores(
      reply([
        { i: 1, score: 400 },
        { i: 2, score: -20 },
      ]),
      2,
    );
    expect(out[0]?.score).toBe(100);
    expect(out[1]?.score).toBe(0);
  });

  it('accepts any array-valued key and a bare array', () => {
    expect(parseBatchScores('{"items":[{"i":1,"score":70}]}', 1)[0]?.score).toBe(70);
    expect(parseBatchScores('[{"i":1,"score":70}]', 1)[0]?.score).toBe(70);
  });

  it('throws when the reply has no array at all', () => {
    expect(() => parseBatchScores('{"score":7}', 1)).toThrow();
    expect(() => parseBatchScores('not json', 1)).toThrow();
  });

  it('reads unpostable and defaults it to false', () => {
    const out = parseBatchScores(
      reply([
        { i: 1, score: 95, unpostable: true },
        { i: 2, score: 5 },
      ]),
      2,
    );
    expect(out[0]?.unpostable).toBe(true);
    expect(out[1]?.unpostable).toBe(false);
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

describe('SCORER_SYSTEM', () => {
  it('tells the rater not to penalize crude content', () => {
    // This clause is why the score distribution is usable on unfiltered streams; if it
    // is ever dropped the rater flattens everything to the middle.
    expect(SCORER_SYSTEM).toMatch(/Do NOT lower a\s*score because a snippet is profane/);
    expect(SCORER_SYSTEM).toMatch(/never refuse/i);
  });

  it('anchors the full 0-100 range', () => {
    for (const band of ['90-100', '70-89', '40-69', '15-39', '0-14']) {
      expect(SCORER_SYSTEM).toContain(band);
    }
  });
});

describe('createChatScorer', () => {
  it('batches snippets across requests and preserves order', async () => {
    const chat: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          reply([
            { i: 1, score: 10 },
            { i: 2, score: 20 },
          ]),
        )
        .mockResolvedValueOnce(reply([{ i: 1, score: 30 }])),
    };
    const scorer = createChatScorer({ chat, model: 'tiny', batchSize: 2 });
    const out = await scorer.scoreBatch(['a', 'b', 'c']);
    expect(out.map((s) => s.score)).toEqual([10, 20, 30]);
    expect(chat.complete).toHaveBeenCalledTimes(2);
  });

  it('requests JSON from the configured model', async () => {
    const chat: ChatClient = { complete: vi.fn().mockResolvedValue(reply([{ i: 1, score: 50 }])) };
    await createChatScorer({ chat, model: 'tiny-model' }).scoreBatch(['a']);
    const [messages, opts] = (chat.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts).toMatchObject({ model: 'tiny-model', json: true, temperature: 0 });
    expect(messages[0].content).toBe(SCORER_SYSTEM);
  });

  it('retries a failing batch', async () => {
    const chat: ChatClient = {
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection error'))
        .mockResolvedValue(reply([{ i: 1, score: 77 }])),
    };
    const scorer = createChatScorer({ chat, model: 'tiny', retries: 2 });
    expect((await scorer.scoreBatch(['a']))[0]?.score).toBe(77);
  });

  it('falls back to neutral scores when a batch never succeeds', async () => {
    const chat: ChatClient = { complete: vi.fn().mockRejectedValue(new Error('boom')) };
    const scorer = createChatScorer({ chat, model: 'tiny', retries: 0 });
    expect(await scorer.scoreBatch(['a', 'b'])).toEqual([NEUTRAL_SCORE, NEUTRAL_SCORE]);
  });
});
