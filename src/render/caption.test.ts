import { describe, expect, it, vi } from 'vitest';
import type { ClipCandidate } from '../core/types.js';
import type { ChatClient } from '../llm/groq.js';
import {
  CAPTION_SYSTEM,
  captionInput,
  fallbackDescriptions,
  fallbackCaption,
  LlmCaptionWriter,
  normalizeCreatorHandle,
  parseCaption,
  parseCaptionPayload,
  withCreatorAttribution,
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

describe('parseCaptionPayload', () => {
  it('extracts platform descriptions with hashtags', () => {
    expect(
      parseCaptionPayload(
        '{"caption":"Title","tiktok":"watch this\\n\\n#fyp #viral","instagram":"watch this too\\n\\n#reels #streamer"}',
      ),
    ).toEqual({
      caption: 'Title',
      tiktok: 'watch this\n\n#fyp #viral',
      instagram: 'watch this too\n\n#reels #streamer',
    });
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

describe('fallbackDescriptions', () => {
  it('writes TikTok and Instagram descriptions with useful hashtags', () => {
    const descriptions = fallbackDescriptions({
      ...candidate,
      kind: 'reaction',
      renderLayout: 'stack',
    });
    expect(descriptions?.tiktok).toMatch(/#fyp/);
    expect(descriptions?.tiktok).toMatch(/#viral/);
    expect(descriptions?.tiktok).toMatch(/#omegle/);
    expect(descriptions?.instagram).toMatch(/#streamer/);
  });

  it('adds creator attribution before hashtags when configured', () => {
    const descriptions = fallbackDescriptions(candidate, 'watch this', '@krimoemp4');
    expect(descriptions.tiktok).toContain('Credit: @krimoemp4');
    expect(descriptions.tiktok).toMatch(/Credit: @krimoemp4\n\n#fyp/);
  });
});

describe('creator attribution', () => {
  it('normalizes bare creator handles', () => {
    expect(normalizeCreatorHandle('krimoemp4')).toBe('@krimoemp4');
    expect(normalizeCreatorHandle('@krimoemp4')).toBe('@krimoemp4');
  });

  it('does not duplicate an existing credit', () => {
    expect(withCreatorAttribution('watch this\n\nCredit: @krimoemp4', '@krimoemp4')).toBe(
      'watch this\n\nCredit: @krimoemp4',
    );
  });
});

describe('captionInput', () => {
  it('marks the punchline as the thing not to give away', () => {
    const out = captionInput({ ...candidate, quote: 'raw, shell and all' });
    expect(out).toContain(`Transcript: ${candidate.transcriptText}`);
    expect(out).toMatch(/do NOT give it away: raw, shell and all/);
  });
  it('sends the transcript alone when there is no punchline', () => {
    expect(captionInput(candidate)).toContain(`Transcript: ${candidate.transcriptText}`);
    expect(captionInput(candidate)).toContain('Score: 80');
    expect(captionInput(candidate)).toContain('Reason: big reaction');
  });
});

describe('CAPTION_SYSTEM', () => {
  it('asks for a premise and forbids spoiling the payoff', () => {
    // A reference clip that performed well is titled "Krimoe plan to go international" — a
    // premise. Quoting the payoff instead produced useless fragments.
    expect(CAPTION_SYSTEM).toMatch(/Write a PREMISE, not a punchline/);
    expect(CAPTION_SYSTEM).toMatch(/never state the outcome/);
    expect(CAPTION_SYSTEM).toMatch(/hashtags/i);
    expect(CAPTION_SYSTEM).toMatch(/#fyp/);
  });
});

describe('LlmCaptionWriter', () => {
  it('returns the model caption', async () => {
    const chat: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValue(
          '{"caption":"He did NOT just say that","tiktok":"this got wild\\n\\n#fyp #viral #streamer","instagram":"this got wild\\n\\n#reels #streamer"}',
        ),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny' });
    expect(await writer.write(candidate)).toEqual({
      text: 'He did NOT just say that',
      descriptions: {
        tiktok: 'this got wild\n\n#fyp #viral #streamer',
        instagram: 'this got wild\n\n#reels #streamer',
      },
    });
  });

  it('adds configured creator credit to model descriptions', async () => {
    const chat: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValue(
          '{"caption":"He did NOT just say that","tiktok":"this got wild\\n\\n#fyp #viral","instagram":"this got wild\\n\\n#reels"}',
        ),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny', creatorHandle: '@krimoemp4' });
    const result = await writer.write(candidate);
    expect(result.descriptions?.tiktok).toContain('Credit: @krimoemp4');
    expect(result.descriptions?.instagram).toContain('Credit: @krimoemp4');
  });

  it('fills missing platform descriptions with hashtag fallbacks', async () => {
    const chat: ChatClient = {
      complete: vi.fn().mockResolvedValue('{"caption":"He did NOT just say that"}'),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny' });
    const result = await writer.write(candidate);
    expect(result.descriptions?.tiktok).toMatch(/#fyp/);
    expect(result.descriptions?.instagram).toMatch(/#viral/);
  });

  it('falls back when the model call fails', async () => {
    const chat: ChatClient = {
      complete: vi.fn().mockRejectedValue(new Error('down')),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny' });
    const result = await writer.write(candidate);
    expect(result.text).toBe(fallbackCaption(candidate));
    expect(result.descriptions?.tiktok).toMatch(/#fyp/);
  });

  it('falls back on an empty caption', async () => {
    const chat: ChatClient = {
      complete: vi.fn().mockResolvedValue('{"caption":"   "}'),
    };
    const writer = new LlmCaptionWriter({ chat, model: 'tiny' });
    expect((await writer.write(candidate)).text).toBe(fallbackCaption(candidate));
  });
});
