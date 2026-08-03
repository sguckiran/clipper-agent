/**
 * OpenAI transcription client adapter. Uses verbose_json with segment + word timestamps so
 * the existing subtitle/candidate pipeline receives the same shape it expected from Groq.
 */
import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import { getConfig, requireValue } from '../config/index.js';
import type { TranscriptionClient, TranscriptionResponse } from './index.js';

/** Build an OpenAI-backed transcription client (requires OPENAI_API_KEY or GPT_API_KEY). */
export function createOpenAiTranscriptionClient(apiKey?: string): TranscriptionClient {
  const key = requireValue(apiKey ?? getConfig().llm.openaiApiKey, 'OPENAI_API_KEY or GPT_API_KEY');
  const openai = new OpenAI({ apiKey: key });
  return {
    async transcribe({ filePath, model }) {
      const res = await openai.audio.transcriptions.create({
        file: createReadStream(filePath),
        model,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment', 'word'],
      });
      return res as unknown as TranscriptionResponse;
    },
  };
}
