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
  type ClipDetectorOptions,
  type TranscriptScorer,
} from './index.js';

const segs = (spec: Array<[number, number, string]>): TranscriptSegment[] =>
  spec.map(([start, end, text]) => ({ start, end, text }));

describe('buildWindows', () => {
  const opts = { minSec: 10, maxSec: 30, targetSec: 12 };

  it('builds sentence-aligned windows that reach the target and end on a sentence', () => {
    const windows = buildWindows(
      segs([
        [0, 6, 'One two three.'],
        [6, 14, 'Four five six seven.'],
        [14, 20, 'Eight nine ten.'],
      ]),
      opts,
    );
    expect(windows.map((w) => [w.startSec, w.endSec])).toEqual([
      [0, 14],
      [6, 20],
    ]);
    expect(windows[0]?.text).toBe('One two three. Four five six seven.');
  });

  it('drops a run-on with no boundary within maxSec', () => {
    expect(buildWindows(segs([[0, 40, 'a b c d e f no punctuation ever']]), opts)).toEqual([]);
  });

  it('uses a silence gap as a boundary when there is no punctuation', () => {
    const windows = buildWindows(
      segs([
        [0, 6, 'one two three'],
        [6, 12, 'four five six'],
        [30, 36, 'seven eight'], // 18s gap before this
      ]),
      opts,
    );
    expect(windows.map((w) => [w.startSec, w.endSec])).toEqual([[0, 12]]);
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
  // One sentence-aligned window [0,20] for this fixture (no punctuation/gaps → the
  // only boundary is the end of the transcript).
  const transcript: Transcript = {
    sourceId: 'src',
    language: 'en',
    segments: segs([
      [0, 5, 'the crowd is going absolutely wild right now'],
      [5, 10, 'i cannot believe what just happened here'],
      [10, 15, 'that was the greatest play of the year'],
      [15, 20, 'we will remember this one for a long time'],
    ]),
    fullText: 'the crowd is going absolutely wild ...',
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

  const BOUNDS = { minSec: 10, maxSec: 30, targetSec: 12 };
  const mk = (opts: Omit<ClipDetectorOptions, keyof typeof BOUNDS>): ScoringClipDetector =>
    new ScoringClipDetector({ ...BOUNDS, ...opts });

  it('returns coherent candidates sorted by score', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 8, reason: 'lol' }),
    };
    const det = mk({ scorer, minScore: 0, maxCandidates: 10, minWordsPerSec: 0 });
    const res = await det.detect(transcript, loudness);
    expect(res.length).toBe(1);
    expect(res[0]?.reason).toBe('lol');
    expect(res[0]?.sourceId).toBe('src');
  });

  it('filters out candidates below minScore', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 0, reason: '' }),
    };
    const det = mk({ scorer, minScore: 60, maxCandidates: 10, minWordsPerSec: 0 });
    // loudness maxes ~100 -> combined ~50 < 60
    expect(await det.detect(transcript, loudness)).toEqual([]);
  });

  it('uses a neutral text score when the scorer throws', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const det = mk({ scorer, minScore: 0, maxCandidates: 10, minWordsPerSec: 0 });
    const res = await det.detect(transcript, loudness);
    expect(res.length).toBe(1);
    expect(res[0]?.reason).toMatch(/unavailable/);
  });

  it('only LLM-scores the shortlist', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 5, reason: 'ok' }),
    };
    const det = mk({
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
    const silent: Transcript = {
      sourceId: 'src',
      language: 'en',
      segments: segs([
        [0, 5, ''],
        [5, 10, ''],
        [10, 15, ''],
        [15, 20, ''],
      ]),
      fullText: '',
    };
    const det = mk({ scorer, minScore: 0, maxCandidates: 10, minWordsPerSec: 0.8 });
    expect(await det.detect(silent, loudness)).toEqual([]);
    expect(scorer.score).not.toHaveBeenCalled(); // gated out before LLM scoring
  });

  it('keeps windows with dense speech through the gate', async () => {
    const scorer: TranscriptScorer = {
      score: vi.fn().mockResolvedValue({ rating: 8, reason: 'good' }),
    };
    const det = mk({ scorer, minScore: 0, maxCandidates: 10, minWordsPerSec: 0.8 });
    const res = await det.detect(transcript, loudness);
    expect(res.length).toBeGreaterThan(0);
    expect(scorer.score).toHaveBeenCalled();
  });
});
