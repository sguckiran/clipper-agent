import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, requireValue, resetConfigCache } from './index.js';

const MANAGED_KEYS = [
  'CLIPPER_RESEARCH_MODEL',
  'CLIPPER_CAPTION_MODEL',
  'CLIPPER_SCORE_LOUDNESS_WEIGHT',
  'CLIPPER_SCORE_TRANSCRIPT_WEIGHT',
  'CLIPPER_MIN_SCORE',
  'CLIPPER_MAX_CANDIDATES',
  'CLIPPER_LLM_SCORE_BUDGET',
  'CLIPPER_LLM_SCORE_BATCH',
  'CLIPPER_SCORE_STRIDE_SEC',
  'CLIPPER_SPICE_WORDS',
  'CLIPPER_FILLER_WORDS',
  'CLIPPER_DROP_UNPOSTABLE',
  'CLIPPER_AXIS_HOOK_WEIGHT',
  'CLIPPER_AXIS_FUNNY_WEIGHT',
  'CLIPPER_AXIS_POCKET_WEIGHT',
  'CLIPPER_AXIS_COHERENCE_WEIGHT',
  'CLIPPER_AXIS_HOOK_FLOOR',
  'CLIPPER_AXIS_FUNNY_FLOOR',
  'CLIPPER_AXIS_POCKET_FLOOR',
  'CLIPPER_AXIS_COHERENCE_FLOOR',
  'CLIPPER_SUBTITLES',
  'CLIPPER_SUBTITLE_FONT_FAMILY',
  'CLIPPER_SUBTITLE_FONT_SIZE',
  'CLIPPER_SUBTITLE_PRIMARY_COLOR',
  'CLIPPER_SUBTITLE_ACCENT_COLOR',
  'CLIPPER_SUBTITLE_OUTLINE_COLOR',
  'CLIPPER_SUBTITLE_SHADOW_COLOR',
  'CLIPPER_SUBTITLE_OUTLINE_PX',
  'CLIPPER_SUBTITLE_SHADOW_PX',
  'CLIPPER_SUBTITLE_MARGIN_V',
  'CLIPPER_SUBTITLE_MAX_WORDS',
  'CLIPPER_SUBTITLE_MIN_DURATION_SEC',
  'CLIPPER_LAYOUT',
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

  it('applies model + scoring + clip defaults', () => {
    const cfg = getConfig();
    expect(cfg.llm.researchModel).toBe('llama-3.3-70b-versatile');
    expect(cfg.llm.captionModel).toBe('llama-3.3-70b-versatile');
    // Transcript-dominant by default: content picks clips, loudness only breaks ties.
    expect(cfg.scoring.transcriptWeight).toBe(0.8);
    expect(cfg.scoring.loudnessWeight).toBe(0.2);
    expect(cfg.scoring.minScore).toBe(55);
    expect(cfg.scoring.maxCandidates).toBe(10);
    expect(cfg.scoring.llmScoreBudget).toBe(400);
    expect(cfg.scoring.llmScoreBatch).toBe(12);
    expect(cfg.scoring.strideSec).toBe(15);
    expect(cfg.scoring.spiceWords).toEqual([]);
    expect(cfg.scoring.fillerWords).toEqual([]);
    expect(cfg.scoring.dropUnpostable).toBe(false);
    expect(cfg.scoring.axisPolicy).toMatchObject({
      hook: { weight: 0.3, floor: 40 },
      funny: { weight: 0.3, floor: 35 },
      pocket: { weight: 0.2, floor: 30 },
      coherence: { weight: 0.2, floor: 60 },
    });
    expect(cfg.clip).toEqual({ minSec: 15, maxSec: 60, targetSec: 30 });
    expect(cfg.render.cropX).toBe('center');
    expect(cfg.render.subtitles).toMatchObject({
      enabled: true,
      fontFamily: 'Arial',
      fontSizePx: 74,
      primaryColor: '#FFFFFF',
      accentColor: '#FFE600',
      outlineColor: '#080808',
      shadowColor: '#080808',
      outlinePx: 7,
      shadowPx: 2,
      marginV: 610,
      maxWordsPerCue: 3,
      minCueDurationSec: 0.45,
      uppercase: true,
    });
  });

  it('parses prescreen word overrides and the unpostable flag', () => {
    process.env.CLIPPER_SPICE_WORDS = ' waffle house , alligator ,';
    process.env.CLIPPER_DROP_UNPOSTABLE = 'true';
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.scoring.spiceWords).toEqual(['waffle house', 'alligator']);
    expect(cfg.scoring.dropUnpostable).toBe(true);
  });

  it('coerces numeric env vars from strings', () => {
    process.env.CLIPPER_MIN_SCORE = '70';
    process.env.CLIPPER_SCORE_LOUDNESS_WEIGHT = '0.7';
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.scoring.minScore).toBe(70);
    expect(cfg.scoring.loudnessWeight).toBe(0.7);
  });

  it('parses subtitle style overrides', () => {
    process.env.CLIPPER_SUBTITLES = 'false';
    process.env.CLIPPER_SUBTITLE_FONT_FAMILY = 'Montserrat ExtraBold';
    process.env.CLIPPER_SUBTITLE_FONT_SIZE = '88';
    process.env.CLIPPER_SUBTITLE_ACCENT_COLOR = '#FF00FF';
    process.env.CLIPPER_SUBTITLE_MAX_WORDS = '2';
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.render.subtitles).toMatchObject({
      enabled: false,
      fontFamily: 'Montserrat ExtraBold',
      fontSizePx: 88,
      accentColor: '#FF00FF',
      maxWordsPerCue: 2,
    });
  });

  it('accepts the fit render layout', () => {
    process.env.CLIPPER_LAYOUT = 'fit';
    resetConfigCache();
    expect(getConfig().render.layout).toBe('fit');
  });

  it('accepts the speaker render layout', () => {
    process.env.CLIPPER_LAYOUT = 'speaker';
    process.env.CLIPPER_PANELS = '34,74,600,448;634,74,600,448';
    resetConfigCache();
    expect(getConfig().render.layout).toBe('speaker');
    expect(getConfig().render.panels).toHaveLength(2);
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
