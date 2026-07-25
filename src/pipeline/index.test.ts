import { describe, expect, it, vi } from 'vitest';
import type {
  CaptionWriter,
  ClipDetector,
  Downloader,
  LoudnessAnalyzer,
  Renderer,
  Transcriber,
} from '../core/contracts.js';
import type {
  Caption,
  Clip,
  ClipCandidate,
  LoudnessTimeline,
  SourceVideo,
  Transcript,
} from '../core/types.js';
import { ClippingPipeline, type PipelineDeps } from './index.js';

const source: SourceVideo = {
  id: 'src',
  url: 'https://twitch.tv/x',
  platform: 'twitch',
  title: 't',
  durationSec: 100,
  localPath: '/dl/src.mp4',
  downloadedAt: '2026-01-01T00:00:00.000Z',
};
const transcript: Transcript = { sourceId: 'src', language: 'en', segments: [], fullText: '' };
const loudness: LoudnessTimeline = { sourceId: 'src', samples: [], baselineRms: -30 };

const cand = (id: string, startSec: number, endSec: number): ClipCandidate => ({
  id,
  sourceId: 'src',
  startSec,
  endSec,
  score: 80,
  reason: 'r',
  transcriptText: 'text',
});

function makeDeps(candidates: ClipCandidate[]): PipelineDeps {
  const downloader: Downloader = { download: vi.fn().mockResolvedValue(source) };
  const transcriber: Transcriber = { transcribe: vi.fn().mockResolvedValue(transcript) };
  const loudnessDep: LoudnessAnalyzer = { analyze: vi.fn().mockResolvedValue(loudness) };
  const detector: ClipDetector = { detect: vi.fn().mockResolvedValue(candidates) };
  const captionWriter: CaptionWriter = {
    write: vi.fn().mockResolvedValue({ text: 'cap' } satisfies Caption),
  };
  const renderer: Renderer = {
    render: vi.fn().mockImplementation(
      async (s: SourceVideo, c: ClipCandidate, caption: Caption): Promise<Clip> => ({
        id: `clip-${c.id}`,
        candidateId: c.id,
        sourceId: c.sourceId,
        startSec: c.startSec,
        endSec: c.endSec,
        caption,
        renderedPath: `/clips/${c.id}.mp4`,
        status: 'rendered',
      }),
    ),
  };
  return { downloader, transcriber, loudness: loudnessDep, detector, captionWriter, renderer };
}

describe('ClippingPipeline', () => {
  it('runs download → transcribe/loudness → detect → caption → render', async () => {
    const deps = makeDeps([cand('c1', 0, 15)]);
    const result = await new ClippingPipeline(deps).run('https://twitch.tv/x', { limit: 5 });

    expect(deps.downloader.download).toHaveBeenCalledWith('https://twitch.tv/x');
    expect(deps.transcriber.transcribe).toHaveBeenCalledWith(source);
    expect(deps.loudness.analyze).toHaveBeenCalledWith(source);
    expect(deps.detector.detect).toHaveBeenCalledWith(transcript, loudness, { limit: 5 });
    expect(deps.captionWriter.write).toHaveBeenCalledOnce();
    expect(result.source).toBe(source);
    expect(result.clips).toHaveLength(1);
    expect(result.clips[0]?.candidateId).toBe('c1');
    expect(result.clips[0]?.caption).toEqual({ text: 'cap' });
  });

  it('skips candidates that violate the 10–20s clip-length rule', async () => {
    const deps = makeDeps([cand('ok', 0, 15), cand('tooShort', 0, 5), cand('tooLong', 0, 40)]);
    const result = await new ClippingPipeline(deps).run('https://twitch.tv/x');

    expect(result.clips.map((c) => c.candidateId)).toEqual(['ok']);
    expect(deps.renderer.render).toHaveBeenCalledOnce();
  });

  it('returns no clips when nothing is detected', async () => {
    const deps = makeDeps([]);
    const result = await new ClippingPipeline(deps).run('https://twitch.tv/x');
    expect(result.clips).toEqual([]);
    expect(deps.renderer.render).not.toHaveBeenCalled();
  });
});
