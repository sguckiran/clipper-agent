/**
 * Real Groq Whisper client adapter. Isolated from ./index.ts so that unit tests
 * (which inject a fake TranscriptionClient) never import the Groq SDK.
 */
import { createReadStream } from 'node:fs';
import Groq from 'groq-sdk';
import { getConfig, requireValue } from '../config/index.js';
import type { TranscriptionClient, TranscriptionResponse } from './index.js';

/** Build a Groq-backed Whisper client from config (requires GROQ_API_KEY). */
export function createGroqTranscriptionClient(apiKey?: string): TranscriptionClient {
  const key = requireValue(apiKey ?? getConfig().llm.groqApiKey, 'GROQ_API_KEY');
  const groq = new Groq({ apiKey: key });
  return {
    async transcribe({ filePath, model }) {
      const params = {
        file: createReadStream(filePath),
        model,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment', 'word'],
      };
      const res = await groq.audio.transcriptions.create(
        params as unknown as Parameters<typeof groq.audio.transcriptions.create>[0],
      );
      return res as unknown as TranscriptionResponse;
    },
  };
}
