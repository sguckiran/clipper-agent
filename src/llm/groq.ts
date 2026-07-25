/**
 * Shared Groq chat client. The research scorer and the caption writer both depend
 * on the small {@link ChatClient} interface; this is the only file that imports the
 * Groq SDK for chat, so their unit tests inject a fake and never hit the network.
 */
import Groq from 'groq-sdk';
import { getConfig, requireValue } from '../config/index.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Request a JSON object response (Groq `response_format`). */
  json?: boolean;
}

export interface ChatClient {
  complete(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
}

/** Build a Groq-backed chat client from config (requires GROQ_API_KEY). */
export function createGroqChatClient(apiKey?: string): ChatClient {
  const key = requireValue(apiKey ?? getConfig().llm.groqApiKey, 'GROQ_API_KEY');
  const groq = new Groq({ apiKey: key });
  return {
    async complete(messages, opts) {
      const res = await groq.chat.completions.create({
        model: opts.model,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 256,
        messages,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      });
      return res.choices[0]?.message?.content ?? '';
    },
  };
}
