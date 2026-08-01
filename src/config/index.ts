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
import { parseRect, type LayoutMode, type PanelRect } from '../render/layout.js';
import type { AxisPolicy, SkillAxis } from '../research/skill.js';

loadDotenv();

const schema = z.object({
  // LLM / transcription. Research + caption run on a small, cheap Groq model so the
  // per-window prompts stay affordable at scale; ANTHROPIC_API_KEY is retained for
  // future modules but is not required by the current pipeline.
  GROQ_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLIPPER_WHISPER_MODEL: z.string().default('whisper-large-v3-turbo'),
  // Research + caption run on a capable Groq model for coherent scoring/captions.
  // Swap for a smaller model (e.g. llama-3.1-8b-instant) to cut cost.
  CLIPPER_RESEARCH_MODEL: z.string().default('llama-3.3-70b-versatile'),
  CLIPPER_CAPTION_MODEL: z.string().default('llama-3.3-70b-versatile'),
  // Audio is chunked to this length before transcription to stay under the Whisper
  // upload limit (~4.8 MB per chunk at 16 kHz mono 64 kbps for the default).
  CLIPPER_TRANSCRIBE_CHUNK_SEC: z.coerce.number().int().positive().default(600),

  // Clip detection / scoring. Final score = transcriptWeight*whatWasSaid + loudnessWeight*loudness.
  // Content is deliberately dominant: loudness only breaks ties between windows the
  // LLM already rated similarly, so a quiet, deadpan, unhinged take can still win.
  CLIPPER_SCORE_TRANSCRIPT_WEIGHT: z.coerce.number().min(0).default(0.8),
  CLIPPER_SCORE_LOUDNESS_WEIGHT: z.coerce.number().min(0).default(0.2),
  CLIPPER_MIN_SCORE: z.coerce.number().min(0).max(100).default(55),
  CLIPPER_MAX_CANDIDATES: z.coerce.number().int().positive().default(10),
  // Minimum words/second a window must contain to be a clip candidate. Filters out
  // applause/music/cheering (loud but no speech). ~0.8 keeps talking, drops silence.
  CLIPPER_MIN_WORDS_PER_SEC: z.coerce.number().min(0).default(0.8),
  // How many windows get LLM-rated per source. Windows above this cap are trimmed by
  // the free lexical prescreen (content-based), NOT by loudness. Raise for better
  // recall on long VODs, lower to cut spend.
  CLIPPER_LLM_SCORE_BUDGET: z.coerce.number().int().positive().default(400),
  // Snippets per LLM request. Batching is what makes rating the whole transcript
  // affordable; too high and small models start dropping entries.
  CLIPPER_LLM_SCORE_BATCH: z.coerce.number().int().positive().max(50).default(12),
  // Minimum seconds between the starts of two windows sent for rating. buildWindows
  // emits one window per sentence boundary, so without this we pay to rate dozens of
  // near-identical overlapping snippets.
  CLIPPER_SCORE_STRIDE_SEC: z.coerce.number().min(0).default(15),
  // Extra comma-separated terms for the prescreen, appended to the built-ins.
  // SPICE = words that mark clip-worthy talk for *your* streamer (inside jokes, names,
  // recurring bits). FILLER = words that mark stream admin you never want clipped.
  CLIPPER_SPICE_WORDS: z.string().default(''),
  CLIPPER_FILLER_WORDS: z.string().default(''),
  // Drop clips the rater flags as likely to get an account banned (slurs, threats at
  // real people). Off by default — the flag is reported either way, so this only
  // matters once you actually publish somewhere with rules.
  CLIPPER_DROP_UNPOSTABLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Clip skill axes. A clip must be funny AND open on a hook AND be out of pocket, so each
  // axis has both a weight (share of the content score) and a FLOOR — below the floor the
  // clip is rejected outright, so nothing rides in on one strong axis while another is
  // broken. Tune the criteria themselves in <dataDir>/prompts/clip-skill.v1.md.
  CLIPPER_AXIS_HOOK_WEIGHT: z.coerce.number().min(0).default(0.4),
  CLIPPER_AXIS_FUNNY_WEIGHT: z.coerce.number().min(0).default(0.35),
  CLIPPER_AXIS_POCKET_WEIGHT: z.coerce.number().min(0).default(0.25),
  CLIPPER_AXIS_HOOK_FLOOR: z.coerce.number().min(0).max(100).default(40),
  CLIPPER_AXIS_FUNNY_FLOOR: z.coerce.number().min(0).max(100).default(35),
  CLIPPER_AXIS_POCKET_FLOOR: z.coerce.number().min(0).max(100).default(30),
  // Seconds of the preceding line kept in front of the hook. Defaults to 0 — a hard cut
  // straight onto the hook. Reference clips that perform well cold-open mid-sentence and let
  // the title card supply the premise, so lead-in mostly buys slower openings. Raise it if
  // you want a beat of run-up.
  CLIPPER_HOOK_LEAD_IN_SEC: z.coerce.number().min(0).default(0),
  // Fail the run when more than this fraction of windows could not be rated. A single failed
  // batch degrades gracefully; a mostly-failed run (rate limit, outage) would score every
  // window a neutral 50 and render clips nobody actually rated, so fail the job instead and
  // let the queue retry it.
  CLIPPER_MAX_UNRATED_FRACTION: z.coerce.number().min(0).max(1).default(0.5),

  // Clip length. Windows are snapped to complete sentences, aiming for TARGET and
  // kept within [MIN, MAX] seconds.
  CLIPPER_CLIP_MIN_SEC: z.coerce.number().positive().default(15),
  CLIPPER_CLIP_MAX_SEC: z.coerce.number().positive().default(60),
  CLIPPER_CLIP_TARGET_SEC: z.coerce.number().positive().default(30),

  // Ingest
  CLIPPER_CLIP_MAX_HEIGHT: z.coerce.number().int().positive().default(1080),

  // Render — explicit caption font file (falls back to a per-OS default)
  CLIPPER_CAPTION_FONT: z.string().optional(),
  // Burn synced word-level subtitles when Whisper provides word timestamps.
  CLIPPER_SUBTITLES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // ASS/libass subtitle style. Font family must be the installed font family name;
  // CLIPPER_CAPTION_FONT is still passed as a fontsdir hint when set.
  CLIPPER_SUBTITLE_FONT_FAMILY: z.string().default('Arial'),
  CLIPPER_SUBTITLE_FONT_SIZE: z.coerce.number().int().positive().default(74),
  CLIPPER_SUBTITLE_PRIMARY_COLOR: z.string().default('#FFFFFF'),
  CLIPPER_SUBTITLE_ACCENT_COLOR: z.string().default('#FFE600'),
  CLIPPER_SUBTITLE_OUTLINE_COLOR: z.string().default('#080808'),
  CLIPPER_SUBTITLE_SHADOW_COLOR: z.string().default('#080808'),
  CLIPPER_SUBTITLE_OUTLINE_PX: z.coerce.number().min(0).default(7),
  CLIPPER_SUBTITLE_SHADOW_PX: z.coerce.number().min(0).default(2),
  CLIPPER_SUBTITLE_MARGIN_V: z.coerce.number().int().min(0).default(610),
  CLIPPER_SUBTITLE_MAX_WORDS: z.coerce.number().int().positive().default(3),
  CLIPPER_SUBTITLE_MIN_DURATION_SEC: z.coerce.number().positive().default(0.45),
  // Horizontal focus of the 9:16 center crop: 'center' | 'left' | 'right' | 0..1.
  // Only used by CLIPPER_LAYOUT=fill.
  CLIPPER_CROP_X: z.string().default('center'),
  // Reframing layout. 'fill' scales the whole frame and slices 9:16 out of it — right for
  // normal footage. 'stack' crops named panels out of the source and stacks them
  // vertically — for screen recordings (e.g. a browser showing two webcams side by side),
  // where the centre of the frame is a window divider, not the subject.
  CLIPPER_LAYOUT: z.enum(['fill', 'stack']).default('fill'),
  // Panels to stack, semicolon-separated "x,y,w,h" rects in SOURCE pixels, top to bottom.
  // Find them by extracting a frame and reading the coordinates off it:
  //   ffmpeg -ss 600 -i vod.mp4 -frames:v 1 frame.png
  CLIPPER_PANELS: z.string().default(''),

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
    /** Max windows to LLM-rate per source. */
    llmScoreBudget: number;
    /** Snippets per LLM rating request. */
    llmScoreBatch: number;
    /** Min seconds between the starts of two rated windows. */
    strideSec: number;
    /** User-supplied prescreen terms, appended to the built-in lists. */
    spiceWords: string[];
    fillerWords: string[];
    /** Drop candidates the rater flags as unpostable. */
    dropUnpostable: boolean;
    /** Per-axis weight + floor for the clip skill's three axes. */
    axisPolicy: Record<SkillAxis, AxisPolicy>;
    /** Seconds of lead-in kept before the hook line. */
    hookLeadInSec: number;
    /** Fail the run above this fraction of unrated windows (0-1). */
    maxUnratedFraction: number;
  };
  clip: {
    minSec: number;
    maxSec: number;
    targetSec: number;
  };
  ingest: {
    maxHeight: number;
  };
  render: {
    /** Explicit caption font file; undefined → per-OS default. */
    captionFont?: string;
    /** Synced subtitle burn-in style. */
    subtitles: {
      enabled: boolean;
      fontFamily: string;
      fontSizePx: number;
      primaryColor: string;
      accentColor: string;
      outlineColor: string;
      shadowColor: string;
      outlinePx: number;
      shadowPx: number;
      marginV: number;
      maxWordsPerCue: number;
      minCueDurationSec: number;
      uppercase: boolean;
    };
    /** Horizontal focus of the crop: 'center' | 'left' | 'right' | numeric 0..1. */
    cropX: string;
    /** Reframing layout: whole-frame slice, or stacked source panels. */
    layout: LayoutMode;
    /** Source panels to stack, top to bottom (only used when layout is 'stack'). */
    panels: PanelRect[];
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

/**
 * Parse semicolon-separated `x,y,w,h` panel rects. Throws on a malformed rect rather than
 * skipping it — silently dropping a panel would render a subtly wrong layout for a whole
 * batch of clips, which is much harder to notice than a startup error.
 */
function parsePanels(raw: string): PanelRect[] {
  return splitSemis(raw).map((entry) => {
    const rect = parseRect(entry);
    if (!rect) {
      throw new Error(
        `Invalid CLIPPER_PANELS entry "${entry}" — expected "x,y,w,h" with positive w/h`,
      );
    }
    return rect;
  });
}

/** Split a semicolon-separated env value into trimmed, non-empty entries. */
function splitSemis(raw: string): string[] {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Split a comma-separated env value into trimmed, non-empty entries. */
function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
      llmScoreBudget: env.CLIPPER_LLM_SCORE_BUDGET,
      llmScoreBatch: env.CLIPPER_LLM_SCORE_BATCH,
      strideSec: env.CLIPPER_SCORE_STRIDE_SEC,
      spiceWords: splitCsv(env.CLIPPER_SPICE_WORDS),
      fillerWords: splitCsv(env.CLIPPER_FILLER_WORDS),
      dropUnpostable: env.CLIPPER_DROP_UNPOSTABLE,
      axisPolicy: {
        hook: { weight: env.CLIPPER_AXIS_HOOK_WEIGHT, floor: env.CLIPPER_AXIS_HOOK_FLOOR },
        funny: { weight: env.CLIPPER_AXIS_FUNNY_WEIGHT, floor: env.CLIPPER_AXIS_FUNNY_FLOOR },
        pocket: { weight: env.CLIPPER_AXIS_POCKET_WEIGHT, floor: env.CLIPPER_AXIS_POCKET_FLOOR },
      },
      hookLeadInSec: env.CLIPPER_HOOK_LEAD_IN_SEC,
      maxUnratedFraction: env.CLIPPER_MAX_UNRATED_FRACTION,
    },
    clip: {
      minSec: env.CLIPPER_CLIP_MIN_SEC,
      maxSec: env.CLIPPER_CLIP_MAX_SEC,
      targetSec: env.CLIPPER_CLIP_TARGET_SEC,
    },
    ingest: {
      maxHeight: env.CLIPPER_CLIP_MAX_HEIGHT,
    },
    render: {
      captionFont: env.CLIPPER_CAPTION_FONT,
      subtitles: {
        enabled: env.CLIPPER_SUBTITLES,
        fontFamily: env.CLIPPER_SUBTITLE_FONT_FAMILY,
        fontSizePx: env.CLIPPER_SUBTITLE_FONT_SIZE,
        primaryColor: env.CLIPPER_SUBTITLE_PRIMARY_COLOR,
        accentColor: env.CLIPPER_SUBTITLE_ACCENT_COLOR,
        outlineColor: env.CLIPPER_SUBTITLE_OUTLINE_COLOR,
        shadowColor: env.CLIPPER_SUBTITLE_SHADOW_COLOR,
        outlinePx: env.CLIPPER_SUBTITLE_OUTLINE_PX,
        shadowPx: env.CLIPPER_SUBTITLE_SHADOW_PX,
        marginV: env.CLIPPER_SUBTITLE_MARGIN_V,
        maxWordsPerCue: env.CLIPPER_SUBTITLE_MAX_WORDS,
        minCueDurationSec: env.CLIPPER_SUBTITLE_MIN_DURATION_SEC,
        uppercase: true,
      },
      cropX: env.CLIPPER_CROP_X,
      layout: env.CLIPPER_LAYOUT,
      panels: parsePanels(env.CLIPPER_PANELS),
    },
    monitor: {
      channels: splitCsv(env.CLIPPER_MONITOR_CHANNELS),
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
