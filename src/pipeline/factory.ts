/**
 * Wires the real, config-backed implementations into a {@link ClippingPipeline}.
 * Kept separate from ./index.ts so the orchestrator's unit tests don't pull in provider
 * SDKs. Building this requires the configured provider key.
 */
import { getConfig } from '../config/index.js';
import { createDownloader } from '../ingest/index.js';
import { createGroqChatClient } from '../llm/groq.js';
import { createOpenAiChatClient } from '../llm/openai.js';
import { createLoudnessAnalyzer } from '../loudness/index.js';
import { createCaptionWriter } from '../render/caption.js';
import { createRenderer, type RendererOptions } from '../render/index.js';
import { createPromptStore } from '../prompts/index.js';
import { createChatScorer, createClipDetector, promptStoreSkillLoader } from '../research/index.js';
import { GroqTranscriber } from '../transcribe/index.js';
import { createGroqTranscriptionClient } from '../transcribe/groq-client.js';
import { createOpenAiTranscriptionClient } from '../transcribe/openai-client.js';
import { ClippingPipeline } from './index.js';

export interface DefaultPipelineOptions {
  renderer?: RendererOptions;
}

export function createDefaultPipeline(opts: DefaultPipelineOptions = {}): ClippingPipeline {
  const cfg = getConfig();
  const chat =
    cfg.llm.provider === 'openai'
      ? createOpenAiChatClient()
      : createGroqChatClient();
  const transcriptionClient =
    cfg.llm.provider === 'openai'
      ? createOpenAiTranscriptionClient()
      : createGroqTranscriptionClient();
  return new ClippingPipeline({
    downloader: createDownloader(),
    transcriber: new GroqTranscriber({ client: transcriptionClient }),
    loudness: createLoudnessAnalyzer(),
    detector: createClipDetector({
      scorer: createChatScorer({
        chat,
        model: cfg.llm.researchModel,
        batchSize: cfg.scoring.llmScoreBatch,
        // The rater consults the skill on every batch, read from the prompt store so the
        // criteria can be retuned on disk without a rebuild.
        skill: promptStoreSkillLoader(createPromptStore()),
      }),
    }),
    captionWriter: createCaptionWriter({ chat }),
    renderer: createRenderer(opts.renderer),
  });
}
