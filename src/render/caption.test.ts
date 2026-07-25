import { describe, expect, it, vi } from 'vitest';
import type { ClipCandidate } from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';
import { fallbackCaption, LlmCaptionWriter, parseCaption } from './caption.js';

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
  it('uses the first few transcript words', () => {
    expect(fallbackCaption(candidate)).toBe(
      'and then absolutely everything went completely wrong on',
    );
  });
  it('falls back to the reason when there is no transcript', () => {
    expect(fallbackCaption({ ...candidate, transcriptText: '' })).toBe('big reaction');
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
