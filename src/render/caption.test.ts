import { describe, expect, it, vi } from 'vitest';
import type { ClipCandidate } from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';
import {
  CAPTION_SYSTEM,
  captionInput,
  fallbackCaption,
  LlmCaptionWriter,
  parseCaption,
} from './caption.js';

const candidate: ClipCandidate = {
  id: 'src-1.0',
  sourceId: 'src',
  startSec: 1,
  endSec: 12,
  score: 80,
  reason: 'big reaction',
  transcriptText: 'and then absolutely everything went completely wrong on stream today folks',
};

describe('parseCaption', () => {
  it('extracts and trims the caption', () => {
    expect(parseCaption('{"caption":"  Insane moment  "}')).toBe('Insane moment');
  });
  it('throws on non-JSON', () => {
    expect(() => parseCaption('nope')).toThrow();
  });
});

describe('fallbackCaption', () => {
  it('uses the opening words, never the punchline', () => {
    // The caption is a title that sets the clip up, so echoing the payoff is worse than a
    // plain premise — even though the punchline is the better *line*.
    expect(fallbackCaption({ ...candidate, quote: 'he ate the whole thing raw' })).toBe(
      'and then absolutely everything went completely wrong on',
    );
  });
  it('falls back to the reason when there is no transcript', () => {
    expect(fallbackCaption({ ...candidate, transcriptText: '' })).toBe('big reaction');
  });
});

describe('captionInput', () => {
  it('marks the punchline as the thing not to give away', () => {
    const out = captionInput({ ...candidate, quote: 'raw, shell and all' });
    expect(out).toContain(`Transcript: ${candidate.transcriptText}`);
    expect(out).toMatch(/do NOT give it away: raw, shell and all/);
  });
  it('sends the transcript alone when there is no punchline', () => {
    expect(captionInput(candidate)).toBe(`Transcript: ${candidate.transcriptText}`);
  });
});

describe('CAPTION_SYSTEM', () => {
  it('asks for a premise and forbids spoiling the payoff', () => {
    // A reference clip that performed well is titled "Krimoe plan to go international" — a
    // premise. Quoting the payoff instead produced useless fragments.
    expect(CAPTION_SYSTEM).toMatch(/Write a PREMISE, not a punchline/);
    expect(CAPTION_SYSTEM).toMatch(/never state the outcome/);
    expect(CAPTION_SYSTEM).toMatch(/Krimoe plan to go international/);
  });
});

describe('LlmCaptionWriter', () => {
  it('returns the model caption', async () => {
    const chat: ChatClient = {
      complete: vi.fn().mockResolvedValue('{"caption":"He did NOT just say that"}'),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny' });
    expect(await writer.write(candidate)).toEqual({ text: 'He did NOT just say that' });
  });

  it('falls back when the model call fails', async () => {
    const chat: ChatClient = {
      complete: vi.fn().mockRejectedValue(new Error('down')),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny' });
    expect((await writer.write(candidate)).text).toBe(fallbackCaption(candidate));
  });

  it('falls back on an empty caption', async () => {
    const chat: ChatClient = {
      complete: vi.fn().mockResolvedValue('{"caption":"   "}'),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny' });
    expect((await writer.write(candidate)).text).toBe(fallbackCaption(candidate));
  });
});
