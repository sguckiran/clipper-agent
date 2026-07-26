import { describe, expect, it, vi } from 'vitest';
import type { ClipCandidate } from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';
import { captionInput, fallbackCaption, LlmCaptionWriter, parseCaption } from './caption.js';

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
  it('prefers the rater’s punchline quote over the setup words', () => {
    expect(fallbackCaption({ ...candidate, quote: 'he ate the whole thing raw' })).toBe(
      'he ate the whole thing raw',
    );
  });
  it('uses the first few transcript words when there is no quote', () => {
    expect(fallbackCaption(candidate)).toBe(
      'and then absolutely everything went completely wrong on',
    );
  });
  it('ignores a blank quote', () => {
    expect(fallbackCaption({ ...candidate, quote: '  ' })).toBe(
      'and then absolutely everything went completely wrong on',
    );
  });
  it('falls back to the reason when there is no transcript', () => {
    expect(fallbackCaption({ ...candidate, transcriptText: '' })).toBe('big reaction');
  });
});

describe('captionInput', () => {
  it('leads with the punchline when one is present', () => {
    expect(captionInput({ ...candidate, quote: 'raw, shell and all' })).toBe(
      `Punchline: raw, shell and all\n\nTranscript: ${candidate.transcriptText}`,
    );
  });
  it('sends the transcript alone otherwise', () => {
    expect(captionInput(candidate)).toBe(candidate.transcriptText);
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
