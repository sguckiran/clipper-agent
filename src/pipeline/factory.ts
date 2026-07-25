/**
 * Wires the real, config-backed implementations into a {@link ClippingPipeline}.
 * Kept separate from ./index.ts so the orchestrator's unit tests don't pull in the
 * Groq SDK. Building this requires GROQ_API_KEY (research, caption, transcription).
 */
import { getConfig } from '../config/index.js';
import { createDownloader } from '../ingest/index.js';
import { createGroqChatClient } from '../llm/groq.js';
import { createLoudnessAnalyzer } from '../loudness/index.js';
import { createCaptionWriter } from '../render/caption.js';
import { createRenderer } from '../render/index.js';
import { createChatScorer, createClipDetector } from '../research/index.js';
import { GroqTranscriber } from '../transcribe/index.js';
import { createGroqTranscriptionClient } from '../transcribe/groq-client.js';
import { ClippingPipeline } from './index.js';

export function createDefaultPipeline(): ClippingPipeline {
  const cfg = getConfig();
  const chat = createGroqChatClient();
  return new ClippingPipeline({
    downloader: createDownloader(),
    transcriber: new GroqTranscriber({ client: createGroqTranscriptionClient() }),
    loudness: createLoudnessAnalyzer(),
    detector: createClipDetector({ scorer: createChatScorer(chat, cfg.llm.researchModel) }),
    captionWriter: createCaptionWriter({ chat }),
    renderer: createRenderer(),
  });
}
