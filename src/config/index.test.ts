import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, requireValue, resetConfigCache } from './index.js';

const MANAGED_KEYS = [
  'CLIPPER_RESEARCH_MODEL',
  'CLIPPER_CAPTION_MODEL',
  'CLIPPER_SCORE_LOUDNESS_WEIGHT',
  'CLIPPER_SCORE_TRANSCRIPT_WEIGHT',
  'CLIPPER_MIN_SCORE',
  'CLIPPER_MAX_CANDIDATES',
  'CLIPPER_MONITOR_CHANNELS',
  'CLIPPER_MONITOR_INTERVAL_SEC',
];

describe('config', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of MANAGED_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetConfigCache();
  });

  afterEach(() => {
    for (const k of MANAGED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigCache();
  });

  it('applies small-model + scoring defaults', () => {
    const cfg = getConfig();
    expect(cfg.llm.researchModel).toBe('llama-3.1-8b-instant');
    expect(cfg.llm.captionModel).toBe('llama-3.1-8b-instant');
    expect(cfg.scoring.loudnessWeight).toBe(0.5);
    expect(cfg.scoring.transcriptWeight).toBe(0.5);
    expect(cfg.scoring.minScore).toBe(55);
    expect(cfg.scoring.maxCandidates).toBe(10);
  });

  it('coerces numeric env vars from strings', () => {
    process.env.CLIPPER_MIN_SCORE = '70';
    process.env.CLIPPER_SCORE_LOUDNESS_WEIGHT = '0.7';
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.scoring.minScore).toBe(70);
    expect(cfg.scoring.loudnessWeight).toBe(0.7);
  });

  it('parses monitor channels into a trimmed, non-empty list', () => {
    process.env.CLIPPER_MONITOR_CHANNELS = ' https://a.tv/x , , https://b.tv/y ';
    resetConfigCache();
    expect(getConfig().monitor.channels).toEqual(['https://a.tv/x', 'https://b.tv/y']);
  });

  it('defaults monitor channels to an empty list', () => {
    expect(getConfig().monitor.channels).toEqual([]);
  });

  it('requireValue throws on missing values', () => {
    expect(() => requireValue(undefined, 'THING')).toThrow(/THING/);
    expect(requireValue('ok', 'THING')).toBe('ok');
  });
});
