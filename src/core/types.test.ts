import { describe, expect, it } from 'vitest';
import {
  CLIP_MAX_SEC,
  CLIP_MIN_SEC,
  isValidClipLength,
  windowDurationSec,
  windowMeanRms,
} from './types.js';
import type { LoudnessTimeline } from './types.js';

describe('clip length rules', () => {
  it('computes window duration', () => {
    expect(windowDurationSec({ startSec: 100, endSec: 115 })).toBe(15);
  });

  it('accepts windows within the 10-20s bound', () => {
    expect(isValidClipLength({ startSec: 0, endSec: CLIP_MIN_SEC })).toBe(true);
    expect(isValidClipLength({ startSec: 0, endSec: 15 })).toBe(true);
    expect(isValidClipLength({ startSec: 0, endSec: CLIP_MAX_SEC })).toBe(true);
  });

  it('rejects windows that are too short or too long', () => {
    expect(isValidClipLength({ startSec: 0, endSec: 9.9 })).toBe(false);
    expect(isValidClipLength({ startSec: 0, endSec: 20.1 })).toBe(false);
  });
});

describe('windowMeanRms', () => {
  const timeline: LoudnessTimeline = {
    sourceId: 's1',
    baselineRms: -30,
    samples: [
      { start: 0, end: 5, rms: -20, peak: -10 },
      { start: 5, end: 10, rms: -10, peak: -2 },
      { start: 10, end: 15, rms: -40, peak: -30 },
    ],
  };

  it('averages the rms of overlapping samples', () => {
    expect(windowMeanRms(timeline, { startSec: 0, endSec: 10 })).toBe(-15);
  });

  it('counts a sample that only partially overlaps', () => {
    // window 8–12 overlaps samples [5,10] and [10,15]
    expect(windowMeanRms(timeline, { startSec: 8, endSec: 12 })).toBe(-25);
  });

  it('falls back to the baseline when nothing overlaps', () => {
    expect(windowMeanRms(timeline, { startSec: 100, endSec: 110 })).toBe(-30);
  });
});
