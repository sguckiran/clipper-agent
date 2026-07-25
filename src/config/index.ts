/**
 * Centralized, validated configuration. Loads `.env` and parses `process.env`
 * through a zod schema so the rest of the app gets a typed, validated config object.
 *
 * Secrets are grouped by concern and marked optional — a given run (e.g. just
 * transcription in dev) should not require publishing credentials to boot. Call
 * {@link requireConfig} sections lazily where you actually need them.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const schema = z.object({
  // LLM / transcription. Research + caption run on a small, cheap Groq model so the
  // per-window prompts stay affordable at scale; ANTHROPIC_API_KEY is retained for
  // future modules but is not required by the current pipeline.
  GROQ_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLIPPER_WHISPER_MODEL: z.string().default('whisper-large-v3-turbo'),
  CLIPPER_RESEARCH_MODEL: z.string().default('llama-3.1-8b-instant'),
  CLIPPER_CAPTION_MODEL: z.string().default('llama-3.1-8b-instant'),
  // Audio is chunked to this length before transcription to stay under the Whisper
  // upload limit (~4.8 MB per chunk at 16 kHz mono 64 kbps for the default).
  CLIPPER_TRANSCRIBE_CHUNK_SEC: z.coerce.number().int().positive().default(600),

  // Clip detection / scoring. Final score = loudnessWeight*loudness + transcriptWeight*text.
  CLIPPER_SCORE_LOUDNESS_WEIGHT: z.coerce.number().min(0).default(0.5),
  CLIPPER_SCORE_TRANSCRIPT_WEIGHT: z.coerce.number().min(0).default(0.5),
  CLIPPER_MIN_SCORE: z.coerce.number().min(0).max(100).default(55),
  CLIPPER_MAX_CANDIDATES: z.coerce.number().int().positive().default(10),
  // Minimum words/second a window must contain to be a clip candidate. Filters out
  // applause/music/cheering (loud but no speech). ~0.8 keeps talking, drops silence.
  CLIPPER_MIN_WORDS_PER_SEC: z.coerce.number().min(0).default(0.8),

  // Ingest
  CLIPPER_CLIP_MAX_HEIGHT: z.coerce.number().int().positive().default(1080),

  // Render — explicit caption font file (falls back to a per-OS default)
  CLIPPER_CAPTION_FONT: z.string().optional(),

  // Channel monitor (auto-enqueue new VODs)
  CLIPPER_MONITOR_CHANNELS: z.string().default(''),
  CLIPPER_MONITOR_INTERVAL_SEC: z.coerce.number().int().positive().default(900),

  // Publishing — TikTok
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_ACCESS_TOKEN: z.string().optional(),

  // Publishing — Instagram
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_BUSINESS_ACCOUNT_ID: z.string().optional(),

  // Publishing — YouTube
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REFRESH_TOKEN: z.string().optional(),

  // Binaries (resolved from PATH when unset)
  CLIPPER_FFMPEG_PATH: z.string().optional(),
  CLIPPER_YT_DLP_PATH: z.string().optional(),

  // Runtime
  CLIPPER_DATA_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config {
  llm: {
    groqApiKey?: string;
    anthropicApiKey?: string;
    whisperModel: string;
    researchModel: string;
    captionModel: string;
    transcribeChunkSec: number;
  };
  scoring: {
    loudnessWeight: number;
    transcriptWeight: number;
    minScore: number;
    maxCandidates: number;
    minWordsPerSec: number;
  };
  ingest: {
    maxHeight: number;
  };
  render: {
    /** Explicit caption font file; undefined → per-OS default. */
    captionFont?: string;
  };
  monitor: {
    /** Channel/playlist URLs to poll for new VODs. */
    channels: string[];
    intervalSec: number;
  };
  publish: {
    tiktok: { clientKey?: string; clientSecret?: string; accessToken?: string };
    instagram: { accessToken?: string; businessAccountId?: string };
    youtube: { clientId?: string; clientSecret?: string; refreshToken?: string };
  };
  bin: {
    ffmpegPath?: string;
    ytDlpPath?: string;
  };
  runtime: {
    dataDir?: string;
    logLevel: RawConfig['LOG_LEVEL'];
    logFormat: RawConfig['LOG_FORMAT'];
  };
}

let cached: Config | undefined;

/** Parse and cache config. Throws if env is structurally invalid. */
export function getConfig(): Config {
  if (cached) return cached;
  const env = schema.parse(process.env);
  cached = {
    llm: {
      groqApiKey: env.GROQ_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      whisperModel: env.CLIPPER_WHISPER_MODEL,
      researchModel: env.CLIPPER_RESEARCH_MODEL,
      captionModel: env.CLIPPER_CAPTION_MODEL,
      transcribeChunkSec: env.CLIPPER_TRANSCRIBE_CHUNK_SEC,
    },
    scoring: {
      loudnessWeight: env.CLIPPER_SCORE_LOUDNESS_WEIGHT,
      transcriptWeight: env.CLIPPER_SCORE_TRANSCRIPT_WEIGHT,
      minScore: env.CLIPPER_MIN_SCORE,
      maxCandidates: env.CLIPPER_MAX_CANDIDATES,
      minWordsPerSec: env.CLIPPER_MIN_WORDS_PER_SEC,
    },
    ingest: {
      maxHeight: env.CLIPPER_CLIP_MAX_HEIGHT,
    },
    render: {
      captionFont: env.CLIPPER_CAPTION_FONT,
    },
    monitor: {
      channels: env.CLIPPER_MONITOR_CHANNELS.split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
      intervalSec: env.CLIPPER_MONITOR_INTERVAL_SEC,
    },
    publish: {
      tiktok: {
        clientKey: env.TIKTOK_CLIENT_KEY,
        clientSecret: env.TIKTOK_CLIENT_SECRET,
        accessToken: env.TIKTOK_ACCESS_TOKEN,
      },
      instagram: {
        accessToken: env.INSTAGRAM_ACCESS_TOKEN,
        businessAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      },
      youtube: {
        clientId: env.YOUTUBE_CLIENT_ID,
        clientSecret: env.YOUTUBE_CLIENT_SECRET,
        refreshToken: env.YOUTUBE_REFRESH_TOKEN,
      },
    },
    bin: {
      ffmpegPath: env.CLIPPER_FFMPEG_PATH,
      ytDlpPath: env.CLIPPER_YT_DLP_PATH,
    },
    runtime: {
      dataDir: env.CLIPPER_DATA_DIR,
      logLevel: env.LOG_LEVEL,
      logFormat: env.LOG_FORMAT,
    },
  };
  return cached;
}

/** Test helper: clear the cached config so the next getConfig() re-reads env. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Assert that a required value is present, throwing a clear error if not. */
export function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}
