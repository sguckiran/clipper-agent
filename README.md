# clipper-agent

Autonomously turns long-form livestream VODs into short, captioned, vertical clips.

Give it a source URL (Twitch / YouTube / Kick VOD) and it downloads the video,
transcribes it, finds the most clip-worthy moments, writes a punchy caption for each,
and renders a vertical 9:16 clip ready for TikTok / Reels / Shorts. It runs one-shot
from the CLI, as a queue worker, or fully hands-off by polling channels for new VODs —
which makes it well suited to running 24/7 on a VM (see
[Running on a VM](#running-on-a-vm-247-automated)).

## Pipeline

```
URL → download (yt-dlp) → transcribe (Groq Whisper) ─┐
                          loudness (ffmpeg ebur128) ─┴→ detect → caption → render → clip.mp4
```

Each stage implements a contract in [`src/core/contracts.ts`](src/core/contracts.ts) and is
dependency-injected, so modules are built and tested independently. The orchestration lives
in [`src/pipeline`](src/pipeline).

## How a clip is "triggered"

Selection is **content-first**: what was actually said picks the clips. Loudness is kept only
as a tiebreaker between windows the rater already liked about equally, because a loud moment
with no payoff is not a clip and the funniest thing in a stream is often said flatly.

1. **Coherent windows** — the transcript is sliced into candidate windows that **start and
   end on sentence boundaries** (or pauses) and aim for a target length within
   `[CLIPPER_CLIP_MIN_SEC, CLIPPER_CLIP_MAX_SEC]` (default 15–60s, target 30s).
2. **Speech gate** — windows without enough talking (`CLIPPER_MIN_WORDS_PER_SEC`) are dropped,
   so pure applause/music/cheering never becomes a clip.
3. **Thin duplicates** — one window per sentence boundary means neighbours say nearly the same
   thing; only windows `CLIPPER_SCORE_STRIDE_SEC` apart go forward.
4. **Content prescreen** (free, no API calls) — if there are still more windows than
   `CLIPPER_LLM_SCORE_BUDGET`, the survivors are chosen on _text_: marker vocabulary, how rare
   a window's words are for this streamer (a topic tangent looks like unusual vocabulary), and
   question density — minus stream-admin filler (sponsor reads, "queue up", "gg"), all scaled
   by word variety so chanting and screaming can't buy their way in. It counts questions but
   deliberately **not** exclamation marks: `!` measures delivery, and rewarding it just
   smuggles the loudness bias back in through the transcript.
5. **LLM rating** — a Groq model rates each surviving window 0–100 against an anchored rubric,
   batched `CLIPPER_LLM_SCORE_BATCH` snippets per request so rating hundreds of windows costs
   tens of calls. It returns a score, a moment type, and the **verbatim punchline**, which is
   used both to trim trailing dead air off the clip and as the caption's hook.
6. Content + loudness are combined (default **80/20**), thresholded on `CLIPPER_MIN_SCORE`,
   de-overlapped, and the top N become clips.

The rubric tells the rater to judge entertainment value only and _not_ to dock points for
profanity, crude, dark or tasteless content — these are unfiltered streams and that material
is most of what clips well. Asked a bare "is this a good clip?", a model hedges on exactly
that content and returns a flat mid score for everything, which silently hands ranking back
to loudness. Tune per streamer with `CLIPPER_SPICE_WORDS` (inside jokes, recurring bits, names
worth catching) and `CLIPPER_FILLER_WORDS` (whatever their stream admin sounds like).

Everything here — weights, threshold, clip length, speech gate, rating budget, candidate cap —
is configurable (see [Configuration](#configuration)).

## Requirements

- Node.js ≥ 20 and pnpm (`corepack enable` provides pnpm)
- [`ffmpeg`](https://ffmpeg.org/) and [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on `PATH`
  (or set `CLIPPER_FFMPEG_PATH` / `CLIPPER_YT_DLP_PATH`)
- A `GROQ_API_KEY` from [console.groq.com](https://console.groq.com) — the only API key the
  pipeline needs (it powers Whisper transcription, clip research, and captions)
- **Google Chrome** — only needed for **Kick** sources (their VODs are captured via a headless
  browser; see [Sources](#sources)). Not required for YouTube/Twitch/local files.

## Quick start

```bash
pnpm install
cp .env.example .env          # then edit .env and set GROQ_API_KEY
pnpm build

node dist/cli/index.js doctor # verify ffmpeg, yt-dlp and the Groq key are found
node dist/cli/index.js run "<twitch-or-youtube-vod-url>" --limit 3
```

Rendered clips (and downloads, transcripts, the job queue, prompts) are written under an
OS-appropriate data directory — `doctor` prints the path. Override it with `CLIPPER_DATA_DIR`.

## Usage

There are three ways to run it, from manual to fully automated.

### 1. One-shot

Clip a single source right now and print the resulting clip paths. Accepts a URL **or a
local video file** (a local path skips the download entirely):

```bash
clipper run <url> [--limit N] [--min-score N]
clipper run ./some-vod.mp4 --limit 10          # clip a file already on disk
```

### 2. Queue + worker

Decouple "what to clip" from "do the work". Enqueue sources (from anywhere — a script, a
cron job, by hand), and run a worker that drains the queue with retries. The queue is
persisted to disk, so the worker survives restarts without losing jobs.

```bash
clipper add <url> [--limit N] [--min-score N]   # enqueue a job
clipper work                                    # process jobs until stopped
clipper queue [pending|running|done|failed]     # inspect the queue
```

### 3. Autonomous (monitor + worker)

Point it at channels and it clips every new VOD on its own. `monitor` polls the configured
channels on an interval and enqueues anything it hasn't seen; `work` renders them. This is
the mode you run on a VM.

```bash
# in .env:  CLIPPER_MONITOR_CHANNELS=https://twitch.tv/foo,https://youtube.com/@bar
clipper monitor   # poll channels, auto-enqueue new VODs (long-running)
clipper work      # process the queue (long-running)
```

`monitor` and `work` are separate long-running processes so you can scale/restart them
independently.

## Sources

| Source     | How it's fetched         | Notes                               |
| ---------- | ------------------------ | ----------------------------------- |
| YouTube    | yt-dlp                   | Fully headless; works on a VM as-is |
| Twitch     | yt-dlp                   | Fully headless; works on a VM as-is |
| **Kick**   | headless Chrome → yt-dlp | Needs Chrome installed (see below)  |
| Local file | none (read from disk)    | `clipper run <path>`                |

**Kick** is special. Kick serves VODs through the Amazon IVS player, which fetches media
inside a WASM Web Worker and only exposes a **signed, short-lived** CloudFront playlist —
yt-dlp/kick-dl can't mint that signature (you get `403 AccessDenied`). So for a `kick.com/…/videos/…`
URL, clipper transparently opens the page in **headless Chrome** (via `playwright-core`),
lets the IVS player start, captures the signed `master.m3u8`, and hands it to yt-dlp. This
requires Google Chrome on the machine; everything else is automatic. Because the signed URL
is short-lived, Kick downloads must complete promptly (fine for typical VOD lengths).

## Configuration

All config is loaded from `.env` and validated in [`src/config/index.ts`](src/config/index.ts);
see `.env.example` for the full list. Key options:

| Env var                                                | Default                   | Purpose                                                                     |
| ------------------------------------------------------ | ------------------------- | --------------------------------------------------------------------------- |
| `GROQ_API_KEY`                                         | —                         | Whisper + research + caption                                                |
| `CLIPPER_RESEARCH_MODEL` / `CLIPPER_CAPTION_MODEL`     | `llama-3.3-70b-versatile` | Groq model for scoring/captions; drop to `llama-3.1-8b-instant` to cut cost |
| `CLIPPER_CLIP_MIN_SEC` / `_MAX_SEC` / `_TARGET_SEC`    | `15` / `60` / `30`        | Clip length bounds + target (sentence-aligned)                              |
| `CLIPPER_MIN_WORDS_PER_SEC`                            | `0.8`                     | Speech gate (drops applause/music)                                          |
| `CLIPPER_SCORE_TRANSCRIPT_WEIGHT` / `_LOUDNESS_WEIGHT` | `0.8` / `0.2`             | Score blend; content-dominant by design                                     |
| `CLIPPER_MIN_SCORE`                                    | `55`                      | Threshold for a candidate                                                   |
| `CLIPPER_MAX_CANDIDATES`                               | `10`                      | Cap per source                                                              |
| `CLIPPER_LLM_SCORE_BUDGET`                             | `400`                     | Max windows rated per source; raise for recall, lower to cut spend          |
| `CLIPPER_LLM_SCORE_BATCH`                              | `12`                      | Snippets per rating request                                                 |
| `CLIPPER_SCORE_STRIDE_SEC`                             | `15`                      | Min gap between rated windows (drops near-duplicates)                       |
| `CLIPPER_SPICE_WORDS` / `CLIPPER_FILLER_WORDS`         | — / —                     | Per-streamer prescreen terms to favour / penalise                           |
| `CLIPPER_DROP_UNPOSTABLE`                              | `false`                   | Drop clips the rater flags as account-ban risk (slurs, threats)             |
| `CLIPPER_CROP_X`                                       | `center`                  | 9:16 crop focus: `center`/`left`/`right`/`0..1`                             |
| `CLIPPER_MONITOR_CHANNELS` / `_INTERVAL_SEC`           | — / `900`                 | Channels to poll + interval                                                 |
| `CLIPPER_DATA_DIR`                                     | OS default                | Where downloads / clips / queue live                                        |
| `LOG_FORMAT`                                           | `pretty`                  | Set to `json` for production/log aggregation                                |

**Tuning:** clip quality is config, not a rebuild — adjust length (`CLIPPER_CLIP_*`),
`CLIPPER_MIN_SCORE`, the transcript/loudness split, the prescreen word lists, or
`CLIPPER_CROP_X`, then restart. If clips feel too safe, raise `CLIPPER_LLM_SCORE_BUDGET` (more
of the VOD gets read) and add the streamer's own vocabulary to `CLIPPER_SPICE_WORDS`. The
rating prompt itself is versioned in the prompt store as `clip-research` (`clipper prompts`)
and mirrored in [`src/research/scorer.ts`](src/research/scorer.ts).

## Running on a VM (24/7, automated)

The end-to-end automated setup: a Linux VM runs `monitor` and `work` as always-on services
that start on boot and restart on failure. Example uses Ubuntu 22.04+ and systemd.

**1. Provision the box**

```bash
# Node.js 20 (NodeSource) + ffmpeg + yt-dlp
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
sudo corepack enable
```

**2. Deploy the app**

```bash
sudo useradd -r -m -d /opt/clipper-agent clipper
sudo -u clipper git clone <your-repo-url> /opt/clipper-agent
cd /opt/clipper-agent
sudo -u clipper pnpm install --frozen-lockfile
sudo -u clipper pnpm build

# configure
sudo -u clipper cp .env.example .env
sudo -u clipper $EDITOR .env   # set GROQ_API_KEY, CLIPPER_MONITOR_CHANNELS, LOG_FORMAT=json
sudo -u clipper chmod 600 .env

# sanity check
sudo -u clipper node dist/cli/index.js doctor
```

**3. Create two systemd services**

`/etc/systemd/system/clipper-work.service`:

```ini
[Unit]
Description=clipper-agent worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=clipper
WorkingDirectory=/opt/clipper-agent
ExecStart=/usr/bin/node dist/cli/index.js work
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/clipper-monitor.service` — identical, but:

```ini
Description=clipper-agent channel monitor
ExecStart=/usr/bin/node dist/cli/index.js monitor
```

(`.env` in `WorkingDirectory` is loaded automatically; `dist/cli/index.js work` reads the
same config as the monitor.)

**4. Enable on boot and watch the logs**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now clipper-monitor clipper-work
journalctl -u clipper-work -u clipper-monitor -f
```

From here it's hands-off: the monitor enqueues new VODs as they appear, the worker renders
clips into the data dir, and both restart automatically after a crash or reboot.

**Updating a deployment**

```bash
cd /opt/clipper-agent
sudo -u clipper git pull
sudo -u clipper pnpm install --frozen-lockfile
sudo -u clipper pnpm build
sudo systemctl restart clipper-monitor clipper-work
```

**Housekeeping** — downloads and rendered clips accumulate. Point `CLIPPER_DATA_DIR` at a
disk with room, and add a cron job to prune old files under `<data>/downloads` and
`<data>/clips`, or ship finished clips off-box, on whatever cadence suits you.

## Development

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

Externals (yt-dlp, ffmpeg, Groq) are injected and mocked in tests, so the suite runs
offline. A live end-to-end run needs the binaries and a Groq key installed locally.

## Not yet implemented

- **Publishing** (TikTok / Instagram / YouTube): the `Publisher` contract is defined but the
  platform integrations are not built — the pipeline currently stops at rendered clips on disk.
  Auto-publishing is the natural next step for a fully automated VM deployment.
- **Real-time (mid-stream) clipping**: the pipeline is VOD/batch-shaped; a "livestream" is
  handled by clipping its VOD.

Verified end-to-end on a 6.6-hour YouTube VOD and a 1-hour Kick VOD: audio is split into
`CLIPPER_TRANSCRIBE_CHUNK_SEC` chunks (each transcribed with per-chunk retry/skip on transient
Groq errors), loudness is measured audio-only (`-vn`), a speech gate drops non-speech windows,
and clips render with captions read from a sidecar file so arbitrary caption text can't break
ffmpeg's filtergraph.
