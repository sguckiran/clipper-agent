import { describe, expect, it } from 'vitest';
import type { ClipCandidate, TranscriptWord } from '../core/types.js';
import {
  assStyleColor,
  buildSubtitleCues,
  DEFAULT_SUBTITLE_STYLE,
  renderAssSubtitles,
  subtitlesFilter,
  subtitlesForCandidate,
} from './subtitles.js';

const words: TranscriptWord[] = [
  { start: 10.1, end: 10.3, text: 'how' },
  { start: 10.35, end: 10.55, text: 'many' },
  { start: 10.6, end: 11.1, text: 'girlfriends' },
  { start: 11.8, end: 12.1, text: 'bro' },
];

describe('buildSubtitleCues', () => {
  it('groups timed words into short uppercase cues relative to the clip start', () => {
    const cues = buildSubtitleCues(words, 10, 20, DEFAULT_SUBTITLE_STYLE);
    expect(cues[0]).toMatchObject({
      startSec: 0.1,
      endSec: 1.1,
      words: ['HOW', 'MANY', 'GIRLFRIENDS'],
      highlightIndex: 2,
    });
    expect(cues[1]).toMatchObject({ words: ['BRO'] });
  });

  it('extends very short cues to the configured minimum duration', () => {
    const cues = buildSubtitleCues(
      [{ start: 5, end: 5.1, text: 'nods' }],
      5,
      10,
      DEFAULT_SUBTITLE_STYLE,
    );
    expect(cues[0]?.endSec).toBeCloseTo(DEFAULT_SUBTITLE_STYLE.minCueDurationSec);
  });

  it('normalizes overlapping word timings into non-overlapping subtitle cues', () => {
    const cues = buildSubtitleCues(
      [
        { start: 10.9, end: 11.75, text: 'have' },
        { start: 11.0, end: 11.75, text: 'four' },
        { start: 11.4, end: 11.9, text: 'forgot' },
      ],
      10,
      15,
      { ...DEFAULT_SUBTITLE_STYLE, maxWordsPerCue: 2 },
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]!.endSec).toBeLessThanOrEqual(cues[1]!.startSec);
  });
});

describe('renderAssSubtitles', () => {
  it('renders an ASS document with bold outlined Opus-style captions', () => {
    const ass = renderAssSubtitles(
      [{ startSec: 0, endSec: 1.5, words: ['HOW', 'MANY', 'GIRLFRIENDS'], highlightIndex: 2 }],
      DEFAULT_SUBTITLE_STYLE,
    );
    expect(ass).toContain('Style: Opus,Arial,74');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.50,Opus');
    expect(ass).toContain('HOW MANY');
    expect(ass).toContain('{\\c&H00E6FF&}GIRLFRIENDS{\\c&HFFFFFF&}');
  });

  it('converts CSS hex colours into ASS style colours', () => {
    expect(assStyleColor('#FFE600')).toBe('&H0000E6FF');
  });
});

describe('subtitlesForCandidate', () => {
  it('returns undefined when no word timings exist', () => {
    const candidate: ClipCandidate = {
      id: 'c',
      sourceId: 's',
      startSec: 10,
      endSec: 20,
      score: 80,
      reason: 'x',
      transcriptText: 'how many girlfriends',
    };
    expect(subtitlesForCandidate(candidate)).toBeUndefined();
  });

  it('renders subtitles from candidate words', () => {
    const candidate: ClipCandidate = {
      id: 'c',
      sourceId: 's',
      startSec: 10,
      endSec: 20,
      score: 80,
      reason: 'x',
      transcriptText: 'how many girlfriends',
      words,
    };
    expect(subtitlesForCandidate(candidate)).toContain('GIRLFRIENDS');
  });
});

describe('subtitlesFilter', () => {
  it('escapes Windows paths for the ffmpeg subtitles filter', () => {
    expect(subtitlesFilter('C:\\tmp\\clip.ass', 'C:\\Windows\\Fonts\\arial.ttf')).toBe(
      "subtitles=filename='C\\:/tmp/clip.ass':fontsdir='C\\:/Windows/Fonts'",
    );
  });
});
