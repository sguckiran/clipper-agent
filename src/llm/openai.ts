/**
 * OpenAI chat client adapter. The rest of the app depends only on ChatClient, so provider
 * changes stay isolated here.
 */
import OpenAI from 'openai';
import { getConfig, requireValue } from '../config/index.js';
import type { ChatClient } from './groq.js';

/** Build an OpenAI-backed chat client from config (requires OPENAI_API_KEY or GPT_API_KEY). */
export function createOpenAiChatClient(apiKey?: string): ChatClient {
  const key = requireValue(apiKey ?? getConfig().llm.openaiApiKey, 'OPENAI_API_KEY or GPT_API_KEY');
  const openai = new OpenAI({ apiKey: key });
  return {
    async complete(messages, opts) {
      const maxCompletionTokens = Math.max(
        opts.maxTokens ?? 256,
        isDefaultTemperatureOnlyModel(opts.model) ? 300 : 1,
      );
      const res = await openai.chat.completions.create({
        model: opts.model,
        messages,
        max_completion_tokens: maxCompletionTokens,
        ...(opts.temperature !== undefined && !isDefaultTemperatureOnlyModel(opts.model)
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      });
      return res.choices[0]?.message?.content ?? '';
    },
  };
}

/**
 * Newer GPT reasoning families often reject non-default temperature values through Chat
 * Completions. Omitting temperature is safer than failing every caption/rating request.
 */
function isDefaultTemperatureOnlyModel(model: string): boolean {
  return /^gpt-5(?:\.|-|$)/i.test(model);
}
