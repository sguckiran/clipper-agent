import { describe, expect, it, vi } from 'vitest';
import type { LoudnessTimeline, Transcript, TranscriptSegment } from '../core/types.js';
import {
  buildWindows,
  combineScores,
  createLoudnessLookup,
  dedupeOverlapping,
  loudnessScore,
  NEUTRAL_SCORE,
  ScoringClipDetector,
  thinByStride,
  trimTrailingAfterQuote,
  wordCount,
  type ClipDetectorOptions,
  type ScoredText,
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

describe('thinByStride', () => {
  it('keeps windows at least strideSec apart', () => {
    const ws = [0, 3, 6, 20, 22, 40].map((startSec) => ({ startSec }));
    expect(thinByStride(ws, 15).map((w) => w.startSec)).toEqual([0, 20, 40]);
  });

  it('is a no-op at stride 0', () => {
    const ws = [{ startSec: 0 }, { startSec: 1 }];
    expect(thinByStride(ws, 0)).toHaveLength(2);
  });
});

describe('trimTrailingAfterQuote', () => {
  const segments = segs([
    [0, 10, 'I got arrested that night, for real.'],
    [10, 16, 'Anyway, what were we talking about?'],
  ]);
  const window = { startSec: 0, endSec: 16, text: 'both segments' };

  it('cuts trailing talk so the clip ends on the punchline', () => {
    const out = trimTrailingAfterQuote(window, 'i got arrested that night', segments, 10);
    expect(out.endSec).toBe(10);
    expect(out.text).toBe('I got arrested that night, for real.');
  });

  it('matches across punctuation and casing differences', () => {
    const out = trimTrailingAfterQuote(window, 'I GOT ARRESTED -- that night!', segments, 10);
    expect(out.endSec).toBe(10);
  });

  it('leaves the window alone when the quote is not found', () => {
    expect(trimTrailingAfterQuote(window, 'something else entirely', segments, 10)).toBe(window);
  });

  it('leaves the window alone for a too-short quote', () => {
    expect(trimTrailingAfterQuote(window, 'yeah', segments, 10)).toBe(window);
  });

  it('never trims below minSec', () => {
    expect(trimTrailingAfterQuote(window, 'i got arrested that night', segments, 12)).toBe(window);
  });

  it('does not bother trimming a trivial saving', () => {
    const short = { startSec: 0, endSec: 11, text: 'x' };
    expect(trimTrailingAfterQuote(short, 'i got arrested that night', segments, 10)).toBe(short);
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

describe('ScoringClipDetector', () => {
  // Two non-overlapping windows with opposite profiles:
  //   [0,12]  LOUD stream admin — nothing was said
  //   [40,52] QUIET unhinged story — the clip you actually want
  const transcript: Transcript = {
    sourceId: 'src',
    language: 'en',
    segments: segs([
      [0, 6, 'Okay chat we are queueing up one more game.'],
      [6, 12, 'Reload and heal me please, go go go.'],
      [40, 46, 'My uncle wrestled an alligator behind a waffle house.'],
      [46, 52, 'He lost, and then he got arrested for it.'],
    ]),
    fullText: 'okay chat ... my uncle wrestled an alligator ...',
  };
  // Loud for the first 12s, at baseline afterwards.
  const loudness: LoudnessTimeline = {
    sourceId: 'src',
    baselineRms: -40,
    samples: Array.from({ length: 60 }, (_, t) => ({
      start: t,
      end: t + 1,
      rms: t < 12 ? -10 : -40,
      peak: 0,
    })),
  };
  const ADMIN = 0;
  const STORY = 40;

  /** A scorer that rates by content: the story is gold, the stream admin is filler. */
  const contentScorer = (extra: Partial<ScoredText> = {}): TranscriptScorer => ({
    scoreBatch: vi.fn(async (snippets: readonly string[]) =>
      snippets.map((s) =>
        s.includes('alligator')
          ? { ...NEUTRAL_SCORE, score: 95, kind: 'story', reason: 'alligator story', ...extra }
          : { ...NEUTRAL_SCORE, score: 10, kind: 'filler', reason: 'stream admin' },
      ),
    ),
  });

  const BOUNDS = { minSec: 10, maxSec: 30, targetSec: 12, strideSec: 15 };
  const mk = (opts: Omit<ClipDetectorOptions, keyof typeof BOUNDS>): ScoringClipDetector =>
    new ScoringClipDetector({ ...BOUNDS, ...opts });

  it('picks the quiet funny moment over the loud empty one', async () => {
    // The regression this module exists for: under the old loudness-gated ranking the
    // alligator story was never even shown to the rater.
    const det = mk({
      scorer: contentScorer(),
      loudnessWeight: 0.2,
      transcriptWeight: 0.8,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    const res = await det.detect(transcript, loudness);
    expect(res.map((c) => c.startSec)).toEqual([STORY, ADMIN]);
    expect(res[0]?.kind).toBe('story');
  });

  it('still prefers the loud moment when loudness is weighted alone', async () => {
    // Proves the flip is driven by the weights, not by an accident of the fixture.
    const det = mk({
      scorer: contentScorer(),
      loudnessWeight: 1,
      transcriptWeight: 0,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    const res = await det.detect(transcript, loudness);
    expect(res[0]?.startSec).toBe(ADMIN);
  });

  it('rates every surviving window, not a loudness shortlist', async () => {
    const scorer = contentScorer();
    const det = mk({ scorer, minScore: 0, maxCandidates: 1, minWordsPerSec: 0 });
    await det.detect(transcript, loudness);
    expect((scorer.scoreBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(2);
  });

  it('carries the rater’s kind, quote and reason onto the candidate', async () => {
    const det = mk({
      scorer: contentScorer({ quote: 'wrestled an alligator behind a waffle house' }),
      minScore: 0,
      maxCandidates: 1,
      minWordsPerSec: 0,
    });
    const [top] = await det.detect(transcript, loudness);
    expect(top?.reason).toBe('alligator story');
    expect(top?.quote).toBe('wrestled an alligator behind a waffle house');
    expect(top?.kind).toBe('story');
  });

  it('filters out candidates below minScore', async () => {
    const det = mk({
      scorer: contentScorer(),
      loudnessWeight: 0.2,
      transcriptWeight: 0.8,
      minScore: 90,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    // story ≈ 0.2*50 + 0.8*95 = 86 < 90
    expect(await det.detect(transcript, loudness)).toEqual([]);
  });

  it('trims to the LLM score budget using the content prescreen', async () => {
    const scorer = contentScorer();
    const det = mk({
      scorer,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
      llmScoreBudget: 1,
    });
    await det.detect(transcript, loudness);
    const rated = (scorer.scoreBatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(rated).toHaveLength(1);
    // The prescreen picks on text: the story survives, the "queue up / reload" admin does not.
    expect(rated[0]).toContain('alligator');
  });

  it('keeps unpostable candidates by default and drops them on request', async () => {
    const flagged = (): TranscriptScorer => ({
      scoreBatch: vi.fn(async (snippets: readonly string[]) =>
        snippets.map((s) => ({
          ...NEUTRAL_SCORE,
          score: s.includes('alligator') ? 95 : 10,
          unpostable: s.includes('alligator'),
        })),
      ),
    });
    const base = { minScore: 0, maxCandidates: 10, minWordsPerSec: 0 };
    const kept = await mk({ scorer: flagged(), ...base }).detect(transcript, loudness);
    expect(kept.some((c) => c.startSec === STORY)).toBe(true);
    expect(kept.find((c) => c.startSec === STORY)?.unpostable).toBe(true);

    const dropped = await mk({ scorer: flagged(), ...base, dropUnpostable: true }).detect(
      transcript,
      loudness,
    );
    expect(dropped.some((c) => c.startSec === STORY)).toBe(false);
  });

  it('drops windows without enough speech (applause/music)', async () => {
    const scorer = contentScorer();
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
    expect(scorer.scoreBatch).toHaveBeenCalledWith([]); // gated out before rating
  });

  it('falls back to neutral scores when the rater returns nothing', async () => {
    const empty: TranscriptScorer = { scoreBatch: vi.fn().mockResolvedValue([]) };
    const det = mk({ scorer: empty, minScore: 0, maxCandidates: 10, minWordsPerSec: 0 });
    const res = await det.detect(transcript, loudness);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.reason).toMatch(/unavailable/);
  });
});
