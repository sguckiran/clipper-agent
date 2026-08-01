import { describe, expect, it, vi } from 'vitest';
import type { LoudnessTimeline, Transcript, TranscriptSegment } from '../core/types.js';
import {
  axisScore,
  buildWindows,
  combineScores,
  createLoudnessLookup,
  DEFAULT_AXIS_POLICY,
  dedupeOverlapping,
  failedAxis,
  formatTimecode,
  locateQuote,
  loudnessScore,
  NEUTRAL_SCORE,
  ScoringClipDetector,
  thinByStride,
  trimLeadingBeforeQuote,
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

  it('preserves word timings for generated subtitle rendering', () => {
    const windows = buildWindows(
      [
        {
          start: 0,
          end: 6,
          text: 'One two three.',
          words: [
            { start: 0.1, end: 0.4, text: 'One' },
            { start: 0.5, end: 0.8, text: 'two' },
            { start: 0.9, end: 1.2, text: 'three' },
          ],
        },
        {
          start: 6,
          end: 14,
          text: 'Four five six seven.',
          words: [
            { start: 6.1, end: 6.4, text: 'Four' },
            { start: 6.5, end: 6.8, text: 'five' },
          ],
        },
      ],
      opts,
    );
    expect(windows[0]?.words?.map((w) => w.text)).toEqual([
      'One',
      'two',
      'three',
      'Four',
      'five',
    ]);
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

  it('trims word timings with the punchline cut', () => {
    const out = trimTrailingAfterQuote(
      {
        ...window,
        words: [
          { start: 1, end: 2, text: 'arrested' },
          { start: 12, end: 13, text: 'Anyway' },
        ],
      },
      'i got arrested that night',
      segments,
      10,
    );
    expect(out.words?.map((w) => w.text)).toEqual(['arrested']);
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

describe('formatTimecode', () => {
  it('formats minutes and seconds', () => {
    expect(formatTimecode(0)).toBe('0m00s');
    expect(formatTimecode(65)).toBe('1m05s');
    expect(formatTimecode(3338.1)).toBe('55m38s');
  });

  it('floors rather than rounds, so seconds never carry to 60', () => {
    // 2939.7s rounded gives the nonsense "48m60s"
    expect(formatTimecode(2939.7)).toBe('48m59s');
  });

  it('clamps negatives', () => {
    expect(formatTimecode(-5)).toBe('0m00s');
  });
});

describe('failedAxis / axisScore', () => {
  const rating = (funny: number, hook: number, pocket: number, coherence = 80) => ({
    funny,
    hook,
    pocket,
    coherence,
  });

  it('clears all floors for a strong clip', () => {
    expect(failedAxis(rating(80, 75, 70), DEFAULT_AXIS_POLICY)).toBeUndefined();
  });

  it('names the axis that failed', () => {
    // hilarious and unhinged, but opens on setup
    expect(failedAxis(rating(95, 20, 90), DEFAULT_AXIS_POLICY)).toBe('hook');
    // shocking with a great opening, but not actually funny
    expect(failedAxis(rating(30, 90, 85), DEFAULT_AXIS_POLICY)).toBe('funny');
    // funny and well-opened, but completely tame
    expect(failedAxis(rating(80, 80, 10), DEFAULT_AXIS_POLICY)).toBe('pocket');
    // funny and spicy, but not understandable without missing context
    expect(failedAxis(rating(90, 90, 90, 30), DEFAULT_AXIS_POLICY)).toBe('coherence');
  });

  it('treats the floor as inclusive', () => {
    const p = DEFAULT_AXIS_POLICY;
    expect(
      failedAxis(rating(p.funny.floor, p.hook.floor, p.pocket.floor, p.coherence.floor), p),
    ).toBeUndefined();
  });

  it('weights the axes and normalizes by the weight sum', () => {
    // all equal means the blend equals the value
    expect(axisScore(rating(60, 60, 60, 60), DEFAULT_AXIS_POLICY)).toBeCloseTo(60);
    expect(axisScore(rating(80, 75, 70, 90), DEFAULT_AXIS_POLICY)).toBeCloseTo(
      (80 * 0.3 + 75 * 0.3 + 70 * 0.2 + 90 * 0.2) / 1,
    );
  });

  it('weights hook highest by default', () => {
    const hookStrong = axisScore(rating(0, 100, 0, 0), DEFAULT_AXIS_POLICY);
    const funnyStrong = axisScore(rating(100, 0, 0, 0), DEFAULT_AXIS_POLICY);
    const pocketStrong = axisScore(rating(0, 0, 100, 0), DEFAULT_AXIS_POLICY);
    const coherenceStrong = axisScore(rating(0, 0, 0, 100), DEFAULT_AXIS_POLICY);
    expect(hookStrong).toBe(funnyStrong);
    expect(funnyStrong).toBeGreaterThan(pocketStrong);
    expect(pocketStrong).toBe(coherenceStrong);
  });

  it('is zero when all weights are zero', () => {
    const zero = {
      hook: { weight: 0, floor: 0 },
      funny: { weight: 0, floor: 0 },
      pocket: { weight: 0, floor: 0 },
      coherence: { weight: 0, floor: 0 },
    };
    expect(axisScore(rating(90, 90, 90, 90), zero)).toBe(0);
  });
});

describe('trimLeadingBeforeQuote', () => {
  const segments = segs([
    [0, 6, 'So anyway, what were we saying about the weekend.'],
    [6, 12, 'WAIT you did WHAT to the car?'],
    [12, 20, 'That is the worst thing I have ever heard.'],
  ]);
  const window = { startSec: 0, endSec: 20, text: 'all three' };

  it('moves the start forward so the clip opens on the hook', () => {
    // leadIn 0 -> snap straight to the hook segment
    const out = trimLeadingBeforeQuote(window, 'wait you did what to the car', segments, 5, 0);
    expect(out.startSec).toBe(6);
    expect(out.text).toBe(
      'WAIT you did WHAT to the car? That is the worst thing I have ever heard.',
    );
  });

  it('keeps exactly the requested lead-in beat so the hook has context', () => {
    // hook starts at 6s; 1.5s of lead-in opens at 4.5s, mid-way through the setup line
    const out = trimLeadingBeforeQuote(window, 'wait you did what to the car', segments, 5, 1.5);
    expect(out.startSec).toBe(4.5);
    // the partially-heard setup segment is still part of the clip's text
    expect(out.text).toContain('what were we saying');
  });

  it('clamps the lead-in to the window start', () => {
    const late = { startSec: 5.5, endSec: 20, text: 'x' };
    const out = trimLeadingBeforeQuote(late, 'wait you did what to the car', segments, 5, 1.5);
    expect(out.startSec).toBe(5.5);
  });

  it('leaves the window alone when it already opens on the hook', () => {
    expect(trimLeadingBeforeQuote(window, 'so anyway what were we saying', segments, 5, 0)).toBe(
      window,
    );
  });

  it('leaves the window alone when the hook is not found', () => {
    expect(trimLeadingBeforeQuote(window, 'something else entirely', segments, 5, 0)).toBe(window);
  });

  it('leaves the window alone for a too-short quote', () => {
    expect(trimLeadingBeforeQuote(window, 'wait', segments, 5, 0)).toBe(window);
  });

  it('never trims below minSec', () => {
    // opening at 6 would leave 14s; demand 16 and it must decline
    expect(trimLeadingBeforeQuote(window, 'wait you did what to the car', segments, 16, 0)).toBe(
      window,
    );
  });

  it('composes with the trailing trim to open on hook and end on punchline', () => {
    const opened = trimLeadingBeforeQuote(window, 'wait you did what to the car', segments, 5, 0);
    const closed = trimTrailingAfterQuote(opened, 'wait you did what to the car', segments, 5);
    expect([closed.startSec, closed.endSec]).toEqual([6, 12]);
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

  /**
   * A scorer that rates by content: the story clears every axis, the stream admin fails
   * them all. Axis values are explicit so floor behaviour is visible in each test.
   */
  const contentScorer = (extra: Partial<ScoredText> = {}): TranscriptScorer => ({
    scoreBatch: vi.fn(async (snippets: readonly string[]) =>
      snippets.map((s) =>
        s.includes('alligator')
          ? {
              ...NEUTRAL_SCORE,
              funny: 95,
              hook: 95,
              pocket: 95,
              coherence: 95,
              kind: 'story',
              reason: 'alligator story',
              ...extra,
            }
          : {
              ...NEUTRAL_SCORE,
              funny: 10,
              hook: 10,
              pocket: 10,
              coherence: 10,
              kind: 'filler',
              reason: 'stream admin',
            },
      ),
    ),
  });

  const BOUNDS = { minSec: 10, maxSec: 30, targetSec: 12, strideSec: 15 };
  const mk = (opts: Omit<ClipDetectorOptions, keyof typeof BOUNDS>): ScoringClipDetector =>
    new ScoringClipDetector({ ...BOUNDS, ...opts });

  it('picks the quiet funny moment over the loud empty one', async () => {
    // The regression this module exists for: under the old loudness-gated ranking the
    // alligator story was never even shown to the rater. The admin window now also fails
    // the axis floors outright, so it does not merely rank lower — it is rejected.
    const det = mk({
      scorer: contentScorer(),
      loudnessWeight: 0.2,
      transcriptWeight: 0.8,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    const res = await det.detect(transcript, loudness);
    expect(res.map((c) => c.startSec)).toEqual([STORY]);
    expect(res[0]?.kind).toBe('story');
  });

  it('ranks by loudness when loudness is weighted alone, among clips that clear floors', async () => {
    // Proves the content/loudness blend is driven by the weights. Both windows are given
    // passing axis scores here so the floors are not what decides the order.
    const allPass: TranscriptScorer = {
      scoreBatch: vi.fn(async (snippets: readonly string[]) =>
        snippets.map(() => ({
          ...NEUTRAL_SCORE,
          funny: 60,
          hook: 60,
          pocket: 60,
          coherence: 60,
          kind: 'take',
          reason: 'rated',
        })),
      ),
    };
    const res = await mk({
      scorer: allPass,
      loudnessWeight: 1,
      transcriptWeight: 0,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
    }).detect(transcript, loudness);
    expect(res[0]?.startSec).toBe(ADMIN); // the loud one
  });

  it('rejects a clip that fails any single axis floor', async () => {
    // Hilarious and unhinged, but it opens on setup — exactly the case floors exist for.
    const noHook: TranscriptScorer = {
      scoreBatch: vi.fn(async (snippets: readonly string[]) =>
        snippets.map(() => ({
          ...NEUTRAL_SCORE,
          funny: 95,
          hook: 10,
          pocket: 90,
          coherence: 90,
          kind: 'story',
          reason: 'rated',
        })),
      ),
    };
    expect(
      await mk({ scorer: noHook, minScore: 0, maxCandidates: 10, minWordsPerSec: 0 }).detect(
        transcript,
        loudness,
      ),
    ).toEqual([]);
  });

  it('honours a custom axis policy', async () => {
    const noHook: TranscriptScorer = {
      scoreBatch: vi.fn(async (snippets: readonly string[]) =>
        snippets.map(() => ({
          ...NEUTRAL_SCORE,
          funny: 95,
          hook: 10,
          pocket: 90,
          coherence: 90,
          kind: 'story',
          reason: 'rated',
        })),
      ),
    };
    // Drop the hook floor to 0 and the same clip is allowed through.
    const res = await mk({
      scorer: noHook,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
      axisPolicy: {
        hook: { weight: 0.4, floor: 0 },
        funny: { weight: 0.35, floor: 35 },
        pocket: { weight: 0.25, floor: 30 },
        coherence: { weight: 0.2, floor: 60 },
      },
    }).detect(transcript, loudness);
    expect(res.length).toBeGreaterThan(0);
  });

  it('rates every surviving window, not a loudness shortlist', async () => {
    const scorer = contentScorer();
    const det = mk({ scorer, minScore: 0, maxCandidates: 1, minWordsPerSec: 0 });
    await det.detect(transcript, loudness);
    expect((scorer.scoreBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(2);
  });

  it('carries the axis scores, quotes, kind and reason onto the candidate', async () => {
    const det = mk({
      scorer: contentScorer({
        punchQuote: 'and then he got arrested for it',
        hookQuote: 'wrestled an alligator behind a waffle house',
      }),
      minScore: 0,
      maxCandidates: 1,
      minWordsPerSec: 0,
    });
    const [top] = await det.detect(transcript, loudness);
    expect(top).toMatchObject({
      reason: 'alligator story',
      kind: 'story',
      funny: 95,
      hook: 95,
      pocket: 95,
      coherence: 95,
      quote: 'and then he got arrested for it',
      hookQuote: 'wrestled an alligator behind a waffle house',
    });
  });

  it('filters out candidates below minScore', async () => {
    const det = mk({
      scorer: contentScorer(),
      loudnessWeight: 0.2,
      transcriptWeight: 0.8,
      minScore: 95,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    // story = 0.2*50 + 0.8*95 = 86 < 95
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

  it('reports risky clips without dropping them', async () => {
    const det = mk({
      scorer: contentScorer({ risky: true }),
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
    });
    const res = await det.detect(transcript, loudness);
    expect(res.find((c) => c.startSec === STORY)?.unpostable).toBe(true);
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

  it('fails the run when most windows could not be rated', async () => {
    // Groq's free tier exhausted its daily token budget mid-run and every batch fell back to
    // a neutral 50 — which clears the floors on arithmetic alone, so the pipeline happily
    // rendered clips nobody had rated. Fail the job instead so the queue can retry it.
    const dead: TranscriptScorer = {
      scoreBatch: vi.fn(async (snippets: readonly string[]) =>
        snippets.map(() => ({ ...NEUTRAL_SCORE })),
      ),
    };
    await expect(
      mk({ scorer: dead, minScore: 0, maxCandidates: 10, minWordsPerSec: 0 }).detect(
        transcript,
        loudness,
      ),
    ).rejects.toThrow(/2\/2 windows.*100% unrated/s);
  });

  it('tolerates a minority of unrated windows', async () => {
    const partial: TranscriptScorer = {
      scoreBatch: vi.fn(async (snippets: readonly string[]) =>
        snippets.map((s) =>
          s.includes('alligator')
            ? {
                ...NEUTRAL_SCORE,
                funny: 90,
                hook: 90,
                pocket: 90,
                coherence: 90,
                kind: 'story',
                reason: 'rated',
              }
            : { ...NEUTRAL_SCORE },
        ),
      ),
    };
    const res = await mk({
      scorer: partial,
      minScore: 0,
      maxCandidates: 10,
      minWordsPerSec: 0,
      maxUnratedFraction: 0.5,
    }).detect(transcript, loudness);
    expect(res.length).toBeGreaterThan(0);
  });
});

describe('locateQuote', () => {
  const segments = segs([
    [0, 4, 'Do you watch Angry Ginge?'],
    [4, 6, 'Yeah.'],
    [6, 12, "So why the fuck don't you watch me, bro?"],
  ]);

  it('finds a quote that spans a segment boundary', () => {
    // Whisper splits speech into short segments, so rater quotes routinely straddle one.
    expect(locateQuote(segments, 'Do you watch Angry Ginge? Yeah')).toEqual({
      startIdx: 0,
      endIdx: 1,
    });
  });

  it('finds a quote inside a single segment', () => {
    expect(locateQuote(segments, "so why the fuck don't you watch me")).toEqual({
      startIdx: 2,
      endIdx: 2,
    });
  });

  it('matches across punctuation and casing', () => {
    expect(locateQuote(segments, 'DO YOU WATCH -- angry ginge!!')).toMatchObject({ startIdx: 0 });
  });

  it('returns undefined for a missing or too-short quote', () => {
    expect(locateQuote(segments, 'something else entirely')).toBeUndefined();
    expect(locateQuote(segments, 'yeah')).toBeUndefined();
  });

  it('skips empty segments without breaking the index mapping', () => {
    const withGap = segs([
      [0, 2, ''],
      [2, 6, 'my uncle wrestled an alligator'],
    ]);
    expect(locateQuote(withGap, 'uncle wrestled an alligator')).toEqual({
      startIdx: 1,
      endIdx: 1,
    });
  });
});
