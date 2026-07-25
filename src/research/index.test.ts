import { describe, expect, it, vi } from 'vitest';
import type { LoudnessTimeline, Transcript, TranscriptSegment } from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';
import {
  buildWindows,
  combineScores,
  createChatScorer,
  createLoudnessLookup,
  dedupeOverlapping,
  loudnessScore,
  parseScore,
  ScoringClipDetector,
  speechDensityScore,
  wordCount,
  type TranscriptScorer,
} from './index.js';

const segs = (spec: Array<[number, number, string]>): TranscriptSegment[] =>
  spec.map(([start, end, text]) => ({ start, end, text }));

describe('buildWindows', () => {
  it('emits the shortest valid window per anchor', () => {
    const windows = buildWindows(
      segs([
        [0, 4, 'a'],
        [4, 8, 'b'],
        [8, 12, 'c'],
        [12, 16, 'd'],
        [16, 20, 'e'],
      ]),
    );
    expect(windows.map((w) => [w.startSec, w.endSec])).toEqual([
      [0, 12],
      [4, 16],
      [8, 20],
    ]);
    expect(windows[0]?.text).toBe('a b c');
  });

  it('caps an overlong segment to the max clip length', () => {
    expect(buildWindows(segs([[0, 30, 'x']]))).toEqual([{ startSec: 0, endSec: 20, text: 'x' }]);
  });

  it('drops a too-short tail', () => {
    expect(
      buildWindows(
        segs([
          [0, 4, 'a'],
          [4, 8, 'b'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('wordCount', () => {
  it('counts whitespace-separated words', () => {
    expect(wordCount('  hello   there  world ')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
  });
});

describe('speechDensityScore', () => {
  it('maps words/sec to 0-100 against the target', () => {
    expect(speechDensityScore(3, 3)).toBe(100);
    expect(speechDensityScore(1.5, 3)).toBe(50);
    expect(speechDensityScore(0, 3)).toBe(0);
    expect(speechDensityScore(6, 3)).toBe(100); // clamped
  });
});

describe('loudnessScore', () => {
  it('maps relative loudness to 0-100 around 50 at baseline', () => {
    expect(loudnessScore(-40, -40, 12)).toBe(50);
    expect(loudnessScore(-28, -40, 12)).toBe(100);
    expect(loudnessScore(-52, -40, 12)).toBe(0);
  });
});

describe('combineScores', () => {
  it('averages evenly at equal weights', () => {
    expect(combineScores(100, 0, 0.5, 0.5)).toBe(50);
  });
  it('normalizes by the weight sum', () => {
    expect(combineScores(80, 40, 0.7, 0.3)).toBeCloseTo(68);
  });
  it('is zero when weights are zero', () => {
    expect(combineScores(80, 40, 0, 0)).toBe(0);
  });
});

describe('createLoudnessLookup', () => {
  const timeline = {
    sourceId: 's',
    baselineRms: -40,
    samples: Array.from({ length: 20 }, (_, t) => ({
      start: t,
      end: t + 1,
      rms: t >= 8 ? -10 : -40,
      peak: 0,
    })),
  };

  it('averages sample rms across a window', () => {
    const lookup = createLoudnessLookup(timeline);
    expect(lookup(8, 20)).toBe(-10);
    expect(lookup(0, 12)).toBe(-30); // 8×-40 + 4×-10 over 12
  });

  it('returns the baseline for a window with no samples', () => {
    expect(createLoudnessLookup(timeline)(100, 110)).toBe(-40);
  });
});

describe('dedupeOverlapping', () => {
  it('keeps the first of each overlapping run', () => {
    const c = (id: string, s: number, e: number, score: number) => ({
      id,
      sourceId: 'x',
      startSec: s,
      endSec: e,
      score,
      reason: '',
      transcriptText: '',
    });
    const kept = dedupeOverlapping([c('a', 0, 12, 90), c('b', 8, 20, 80), c('c', 25, 40, 70)]);
    expect(kept.map((k) => k.id)).toEqual(['a', 'c']);
  });
});

describe('parseScore', () => {
  it('clamps rating to 0-10', () => {
    expect(parseScore('{"rating":15,"reason":"x"}').rating).toBe(10);
    expect(parseScore('{"rating":-3,"reason":""}').rating).toBe(0);
  });
  it('throws on non-JSON', () => {
    expect(() => parseScore('nope')).toThrow();
  });
});

describe('createChatScorer', () => {
  it('sends a tiny JSON prompt and parses the reply', async () => {
    const chat: ChatClient = {
      complete: vi.fn().mockResolvedValue('{"rating": 7, "reason": "big reaction"}'),
    };
    const scorer = createChatScorer(chat, 'tiny-model');
    expect(await scorer.score('crowd goes wild')).toEqual({ rating: 7, reason: 'big reaction' });
    const [, opts] = (chat.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts).toMatchObject({ model: 'tiny-model', json: true });
  });
});

describe('ScoringClipDetector', () => {
  const transcript: Transcript = {
    sourceId: 'src',
    language: 'en',
    segments: segs([
      [0, 4, 'a'],
      [4, 8, 'b'],
      [8, 12, 'c'],
      [12, 16, 'd'],
      [16, 20, 'e'],
    ]),
    fullText: 'a b c d e',
  };
  const loudness: LoudnessTimeline = {
    sourceId: 'src',
    baselineRms: -40,
    samples: Array.from({ length: 20 }, (_, t) => ({
      start: t,
      end: t + 1,
      rms: t >= 8 ? -10 : -40,
      peak: 0,
    })),
  };

  it('returns non-overlapping candidates sorted by score', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 8, reason: 'lol' }),
    };
    const det = new ScoringClipDetector({
      scorer,
      loudnessWeight: 0.5,
      transcriptWeight: 0.5,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    const res = await det.detect(transcript, loudness);
    expect(res.length).toBe(1); // all windows overlap -> one survives
    expect(res[0]?.reason).toBe('lol');
    expect(res[0]?.sourceId).toBe('src');
  });

  it('filters out candidates below minScore', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 0, reason: '' }),
    };
    const det = new ScoringClipDetector({
      scorer,
      loudnessWeight: 0.5,
      transcriptWeight: 0.5,
      minScore: 60,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    // loudness maxes ~100 -> combined ~50 < 60
    expect(await det.detect(transcript, loudness)).toEqual([]);
  });

  it('uses a neutral text score when the scorer throws', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const det = new ScoringClipDetector({
      scorer,
      loudnessWeight: 0.5,
      transcriptWeight: 0.5,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    const res = await det.detect(transcript, loudness);
    expect(res.length).toBe(1);
    expect(res[0]?.reason).toMatch(/unavailable/);
  });

  it('only LLM-scores the loudness shortlist', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 5, reason: 'ok' }),
    };
    const det = new ScoringClipDetector({
      scorer,
      minScore: 0,
      maxCandidates: 1,
      shortlistMultiplier: 1,
      minWordsPerSec: 0,
    });
    await det.detect(transcript, loudness);
    expect(scorer.score).toHaveBeenCalledTimes(1);
  });

  it('drops windows without enough speech (applause/music)', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 10, reason: 'loud' }),
    };
    // empty transcript text over the whole timeline = no speech, however loud
    const silent: Transcript = {
      sourceId: 'src',
      language: 'en',
      segments: segs([
        [0, 4, ''],
        [4, 8, ''],
        [8, 12, ''],
        [12, 16, ''],
        [16, 20, ''],
      ]),
      fullText: '',
    };
    const det = new ScoringClipDetector({
      scorer,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0.8,
    });
    expect(await det.detect(silent, loudness)).toEqual([]);
    expect(scorer.score).not.toHaveBeenCalled(); // gated out before LLM scoring
  });

  it('keeps windows with dense speech through the gate', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 8, reason: 'good' }),
    };
    const talky: Transcript = {
      sourceId: 'src',
      language: 'en',
      segments: segs([
        [0, 4, 'one two three four'],
        [4, 8, 'five six seven eight'],
        [8, 12, 'nine ten eleven twelve'],
      ]),
      fullText: 'one two three four five six seven eight nine ten eleven twelve',
    };
    const det = new ScoringClipDetector({
      scorer,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0.8,
    });
    const res = await det.detect(talky, loudness);
    expect(res.length).toBeGreaterThan(0);
    expect(scorer.score).toHaveBeenCalled();
  });
});
