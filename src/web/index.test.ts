import { describe, expect, it } from 'vitest';
import type { ClipCandidate } from '../core/types.js';
import { qualityMeter } from './index.js';

const candidate = (over: Partial<ClipCandidate>): ClipCandidate => ({
  id: 'c',
  sourceId: 's',
  startSec: 0,
  endSec: 20,
  score: 90,
  reason: 'r',
  transcriptText: 't',
  funny: 90,
  hook: 90,
  pocket: 90,
  coherence: 90,
  ...over,
});

describe('qualityMeter', () => {
  it('uses the weakest required dimension as an AND gate', () => {
    expect(qualityMeter(candidate({ score: 95, funny: 92, hook: 88, coherence: 91 }))).toBe(88);
    expect(qualityMeter(candidate({ coherence: 42 }))).toBe(42);
    expect(qualityMeter(candidate({ funny: 30 }))).toBe(30);
  });

  it('does not let a high virality score hide missing coherence', () => {
    expect(qualityMeter(candidate({ score: 99, funny: 99, hook: 99, coherence: 55 }))).toBe(55);
  });
});
