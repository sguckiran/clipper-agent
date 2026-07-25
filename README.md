# clipper-agent

Autonomously turns long-form livestream VODs into short, captioned, vertical clips.

Give it a source URL (Twitch / YouTube / Kick VOD) and it downloads the video,
transcribes it, finds the most clip-worthy moments, writes a punchy caption for each,
and renders a vertical 9:16 clip ready for TikTok / Reels / Shorts. It runs one-shot
from the CLI, as a queue worker, or fully hands-off by polling channels for new VODs.

## Pipeline

```
URL → download (yt-dlp) → transcribe (Groq Whisper) ─┐
                          loudness (ffmpeg ebur128) ─┴→ detect → caption → render → clip.mp4
```

Each stage implements a contract in [`src/core/contracts.ts`](src/core/contracts.ts) and is
dependency-injected, so modules are built and tested independently. The orchestration lives
in [`src/pipeline`](src/pipeline).

## How a clip is "triggered"

Clip detection is **loudness-primary with a tiny-LLM confirm** — loud moments (crowd
reactions, laughter, shouting) are the strongest signal that something clippable happened,
and they're free to compute from the audio.

1. The transcript is sliced into valid **10–20s** windows (the project clip-length rule,
   enforced in [`src/core/types.ts`](src/core/types.ts)).
2. Each window gets a **loudness score** (0–100) from the ffmpeg loudness timeline, relative
   to the source's baseline.
3. The loudest windows are shortlisted and a **small, cheap Groq model** gives a tiny
   transcript rating (0–10) — the prompt is deliberately minimal so a small model works.
4. The two signals are combined (default **50/50**, configurable), filtered by a minimum
   score, de-overlapped, and the top N become clip candidates.

Both weights, the minimum score, and the candidate cap are configurable (see below).

## Requirements

- Node.js ≥ 20, pnpm
- [`ffmpeg`](https://ffmpeg.org/) and [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on `PATH`
  (or set `CLIPPER_FFMPEG_PATH` / `CLIPPER_YT_DLP_PATH`)
- A `GROQ_API_KEY` (powers Whisper transcription, clip research, and captions)

Copy `.env.example` to `.env` and fill it in. Then check your machine:

```bash
pnpm install
pnpm build
node dist/cli/index.js doctor
```

## CLI

```
clipper run <url>      Clip a source now (--limit N, --min-score N)
clipper add <url>      Enqueue a source URL for the worker
clipper work           Run the queue worker (processes enqueued sources)
clipper monitor        Poll configured channels and auto-enqueue new VODs
clipper queue [status] List queued jobs (pending|running|done|failed)
clipper prompts        List prompts (or: prompts show <name> [version])
clipper doctor         Check environment (binaries, config, paths)
```

Clips, downloads, transcripts, the job queue, and prompts are stored under an OS-appropriate
data directory (override with `CLIPPER_DATA_DIR`).

## Configuration

All config is validated in [`src/config/index.ts`](src/config/index.ts); see `.env.example` for
the full list. Key options:

| Env var                                                | Default                | Purpose                                                     |
| ------------------------------------------------------ | ---------------------- | ----------------------------------------------------------- |
| `GROQ_API_KEY`                                         | —                      | Whisper + research + caption                                |
| `CLIPPER_RESEARCH_MODEL`                               | `llama-3.1-8b-instant` | Small Groq model for scoring; swap for any cheap Groq model |
| `CLIPPER_CAPTION_MODEL`                                | `llama-3.1-8b-instant` | Small Groq model for captions                               |
| `CLIPPER_SCORE_LOUDNESS_WEIGHT` / `_TRANSCRIPT_WEIGHT` | `0.5` / `0.5`          | Score blend                                                 |
| `CLIPPER_MIN_SCORE`                                    | `55`                   | Threshold for a candidate                                   |
| `CLIPPER_MAX_CANDIDATES`                               | `10`                   | Cap per source                                              |
| `CLIPPER_MONITOR_CHANNELS`                             | —                      | Comma-separated channel URLs to poll                        |
| `CLIPPER_MONITOR_INTERVAL_SEC`                         | `900`                  | Poll interval                                               |

## Development

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

Externals (yt-dlp, ffmpeg, Groq) are injected and mocked in tests, so the suite runs
offline. A live end-to-end run needs the binaries and a Groq key installed locally.

## Not yet implemented

- **Publishing** (TikTok / Instagram / YouTube): the `Publisher` contract is defined but the
  platform integrations are not built — the pipeline currently stops at rendered clips on disk.
- **Real-time (mid-stream) clipping**: the pipeline is VOD/batch-shaped; a "livestream" is
  handled by clipping its VOD.
