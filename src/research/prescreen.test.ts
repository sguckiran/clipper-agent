import { describe, expect, it } from 'vitest';
import {
  buildIdf,
  compileMarkers,
  contentWords,
  countMarkers,
  createPrescreen,
  deliveryScore,
  markerScore,
  noveltyScore,
  varietyScore,
} from './prescreen.js';

describe('compileMarkers / countMarkers', () => {
  it('matches whole words only', () => {
    const re = compileMarkers(['ass', 'shit']);
    expect(countMarkers('I assume the assistant is fine', re)).toBe(0);
    expect(countMarkers('my ass hurts', re)).toBe(1);
    expect(countMarkers('shit, that is shit', re)).toBe(2);
  });

  it('matches multi-word phrases and is case-insensitive', () => {
    const re = compileMarkers(['would you rather', 'no way']);
    expect(countMarkers('Okay, WOULD YOU RATHER die? No way.', re)).toBe(2);
  });

  it('escapes regex metacharacters in terms', () => {
    const re = compileMarkers(['c++', 'what?']);
    expect(() => countMarkers('c++ is fine', re)).not.toThrow();
  });

  it('is reusable across calls (no lastIndex leakage)', () => {
    const re = compileMarkers(['shit']);
    expect(countMarkers('shit', re)).toBe(1);
    expect(countMarkers('shit', re)).toBe(1);
  });
});

describe('contentWords', () => {
  it('keeps long non-stopwords, lowercased', () => {
    expect(contentWords('The DOG ate my homework and that was really bad')).toEqual(['homework']);
  });
});

describe('buildIdf / noveltyScore', () => {
  const docs = [
    'ranked gameplay lobby queue',
    'ranked gameplay lobby queue',
    'ranked gameplay lobby queue',
    'my uncle wrestled an alligator behind a waffle house',
  ];

  it('scores an off-topic window above the streamer’s usual vocabulary', () => {
    const idf = buildIdf(docs);
    const usual = noveltyScore(docs[0]!, idf, docs.length);
    const tangent = noveltyScore(docs[3]!, idf, docs.length);
    expect(tangent).toBeGreaterThan(usual);
  });

  it('returns 0 for text with no content words', () => {
    expect(noveltyScore('a b c', buildIdf(docs), docs.length)).toBe(0);
  });

  it('treats unseen words as maximally novel', () => {
    expect(noveltyScore('kangaroo tribunal', new Map(), 10)).toBe(100);
  });
});

describe('deliveryScore / markerScore', () => {
  it('rises with question density', () => {
    expect(deliveryScore('what? why? how? seriously?', 30)).toBeGreaterThan(
      deliveryScore('a statement.', 30),
    );
  });

  it('ignores exclamation marks, which measure delivery rather than content', () => {
    expect(deliveryScore('YES! LETS GO! YES! INSANE!', 30)).toBe(0);
  });

  it('clamps to 0-100', () => {
    expect(markerScore(1000, 30)).toBe(100);
    expect(markerScore(0, 30)).toBe(0);
  });

  it('normalizes by duration, not raw hits', () => {
    expect(markerScore(5, 30)).toBeGreaterThan(markerScore(5, 120));
  });
});

describe('varietyScore', () => {
  it('drops for repetition and stays high for real talk', () => {
    expect(varietyScore("let's go let's go let's go yes yes yes")).toBeLessThan(
      varietyScore('my uncle wrestled an alligator behind a waffle house'),
    );
  });

  it('returns 0 for too little text to judge', () => {
    expect(varietyScore('yes yes')).toBe(0);
  });
});

describe('createPrescreen', () => {
  const texts = [
    'so anyway I got arrested that night and I swear to god the cops were laughing',
    'okay chat we are going to queue up one more game, reload and heal me',
    'the weather today is mild and I had a sandwich for lunch',
  ];

  it('ranks pure hype below ordinary conversation', () => {
    // The regression this replaced: loudness-shaped signals (chanting, screaming) used to
    // rank near the top of the prescreen and eat the rating budget.
    const hype = 'LETS GO! LETS GO! YES! YES! OH MY GOD! LETS GO!';
    const pre = createPrescreen([...texts, hype]);
    expect(pre.score(hype, 30).score).toBeLessThan(pre.score(texts[2]!, 30).score);
  });

  it('ranks a wild story above ordinary talk and above stream admin', () => {
    const pre = createPrescreen(texts);
    const story = pre.score(texts[0]!, 30).score;
    const admin = pre.score(texts[1]!, 30).score;
    const ordinary = pre.score(texts[2]!, 30).score;
    expect(story).toBeGreaterThan(ordinary);
    expect(story).toBeGreaterThan(admin);
  });

  it('penalizes filler hits', () => {
    const pre = createPrescreen(texts);
    expect(pre.score(texts[1]!, 30).fillerHits).toBeGreaterThan(0);
  });

  it('honours caller-supplied spice words', () => {
    const custom = createPrescreen(texts, { spiceWords: ['sandwich'] });
    const plain = createPrescreen(texts);
    expect(custom.score(texts[2]!, 30).marker).toBeGreaterThan(plain.score(texts[2]!, 30).marker);
  });

  it('clamps the combined score to 0-100', () => {
    const pre = createPrescreen(texts, { fillerWords: ['weather', 'sandwich', 'mild'] });
    expect(pre.score(texts[2]!, 30).score).toBe(0);
  });
});
