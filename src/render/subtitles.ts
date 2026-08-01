import { dirname } from 'node:path';
import type { ClipCandidate, TranscriptWord } from '../core/types.js';

/**
 * Escape a file path for an ffmpeg filter option value: forward slashes and escaped
 * Windows drive-letter colon (e.g. `C\:/Windows/Fonts/arial.ttf`).
 */
export function escapeSubtitleFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/** ASS subtitle styling tuned for short-form livestream clips. */
export interface SubtitleStyle {
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
}

/** Default: bold, centered, Opus/TikTok-style chunky subtitles. */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  enabled: true,
  fontFamily: 'Arial',
  fontSizePx: 74,
  primaryColor: '#FFFFFF',
  accentColor: '#FFE600',
  outlineColor: '#080808',
  shadowColor: '#080808',
  outlinePx: 7,
  shadowPx: 2,
  marginV: 610,
  maxWordsPerCue: 3,
  minCueDurationSec: 0.45,
  uppercase: true,
};

export interface SubtitleCue {
  startSec: number;
  endSec: number;
  words: string[];
  highlightIndex: number;
}

function stripWord(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function cueText(words: readonly string[], uppercase: boolean): string[] {
  return words
    .map((w) => stripWord(w))
    .filter(Boolean)
    .map((w) => (uppercase ? w.toUpperCase() : w));
}

function roundCueTime(sec: number): number {
  return Math.round(sec * 100) / 100;
}

function withoutOverlaps(cues: readonly SubtitleCue[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    const next: SubtitleCue = { ...cue };
    const prev = out[out.length - 1];
    if (prev && next.startSec < prev.endSec) {
      prev.endSec = roundCueTime(Math.max(prev.startSec + 0.05, next.startSec));
      if (prev.endSec > next.startSec) next.startSec = prev.endSec;
    }
    if (next.endSec <= next.startSec) {
      next.endSec = roundCueTime(next.startSec + 0.05);
    }
    out.push(next);
  }
  return out.filter((cue) => cue.endSec > cue.startSec);
}

/** Build short 1-3 word subtitle cues from timed words. */
export function buildSubtitleCues(
  words: readonly TranscriptWord[],
  clipStartSec: number,
  clipEndSec: number,
  style: Pick<SubtitleStyle, 'maxWordsPerCue' | 'minCueDurationSec' | 'uppercase'> = DEFAULT_SUBTITLE_STYLE,
): SubtitleCue[] {
  const timed = words
    .filter((w) => w.end > clipStartSec && w.start < clipEndSec)
    .map((w) => ({
      start: Math.max(0, w.start - clipStartSec),
      end: Math.max(0, w.end - clipStartSec),
      text: stripWord(w.text),
    }))
    .filter((w) => w.text.length > 0)
    .sort((a, b) => a.start - b.start);

  const cues: SubtitleCue[] = [];
  let i = 0;
  while (i < timed.length) {
    const start = timed[i]?.start ?? 0;
    const group: typeof timed = [];
    let lastEnd = start;
    while (i < timed.length && group.length < Math.max(1, style.maxWordsPerCue)) {
      const w = timed[i];
      if (!w) break;
      const gap = group.length === 0 ? 0 : w.start - lastEnd;
      if (group.length > 0 && gap > 0.45) break;
      group.push(w);
      lastEnd = w.end;
      i++;
      if (/[.!?…]$/.test(w.text)) break;
    }
    const wordsForCue = cueText(
      group.map((w) => w.text),
      style.uppercase,
    );
    if (wordsForCue.length === 0) continue;
    const rawEnd = group[group.length - 1]?.end ?? start;
    const end = Math.min(clipEndSec - clipStartSec, Math.max(rawEnd, start + style.minCueDurationSec));
    cues.push({
      startSec: roundCueTime(start),
      endSec: roundCueTime(Math.max(end, start + 0.05)),
      words: wordsForCue,
      highlightIndex: chooseHighlight(wordsForCue),
    });
  }
  return withoutOverlaps(cues);
}

function chooseHighlight(words: readonly string[]): number {
  if (words.length <= 1) return 0;
  let best = words.length - 1;
  for (const [i, word] of words.entries()) {
    if (word.replace(/[^A-Z0-9]/gi, '').length > words[best]!.replace(/[^A-Z0-9]/gi, '').length) {
      best = i;
    }
  }
  return best;
}

function assTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const centis = Math.floor((clamped - Math.floor(clamped)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    centis,
  ).padStart(2, '0')}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return { r: 255, g: 255, b: 255 };
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

/** ASS style colour: &HAABBGGRR. */
export function assStyleColor(hex: string, alpha = '00'): string {
  const { r, g, b } = hexToRgb(hex);
  return `&H${alpha}${b.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${r
    .toString(16)
    .padStart(2, '0')}`.toUpperCase();
}

/** ASS inline colour tag: &HBBGGRR&. */
function assInlineColor(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `&H${b.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${r
    .toString(16)
    .padStart(2, '0')}&`.toUpperCase();
}

function escapeAssText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
}

function renderCueText(cue: SubtitleCue, style: SubtitleStyle): string {
  const primary = assInlineColor(style.primaryColor);
  const accent = assInlineColor(style.accentColor);
  return cue.words
    .map((word, i) => {
      const safe = escapeAssText(word);
      return i === cue.highlightIndex ? `{\\c${accent}}${safe}{\\c${primary}}` : safe;
    })
    .join(' ');
}

/** Generate a complete Advanced SubStation Alpha subtitle document. */
export function renderAssSubtitles(cues: readonly SubtitleCue[], style: SubtitleStyle): string {
  const events = cues
    .filter((cue) => cue.endSec > cue.startSec)
    .map(
      (cue) =>
        `Dialogue: 0,${assTime(cue.startSec)},${assTime(cue.endSec)},Opus,,0,0,0,,${renderCueText(
          cue,
          style,
        )}`,
    )
    .join('\n');

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Opus,${style.fontFamily},${style.fontSizePx},${assStyleColor(
      style.primaryColor,
    )},${assStyleColor(style.accentColor)},${assStyleColor(style.outlineColor)},${assStyleColor(
      style.shadowColor,
      '80',
    )},1,0,0,0,100,100,0,0,1,${style.outlinePx},${style.shadowPx},2,80,80,${
      style.marginV
    },1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    events,
    '',
  ].join('\n');
}

/** Return ASS subtitles for a clip candidate, or undefined when no word timings exist. */
export function subtitlesForCandidate(
  candidate: ClipCandidate,
  style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): string | undefined {
  if (!style.enabled || !candidate.words || candidate.words.length === 0) return undefined;
  const cues = buildSubtitleCues(candidate.words, candidate.startSec, candidate.endSec, style);
  if (cues.length === 0) return undefined;
  return renderAssSubtitles(cues, style);
}

/** ffmpeg filter that burns an ASS subtitle file using libass. */
export function subtitlesFilter(assFile: string, fontFile?: string): string {
  const fontsDir = fontFile ? dirname(fontFile) : undefined;
  return (
    `subtitles=filename='${escapeSubtitleFilterPath(assFile)}'` +
    (fontsDir ? `:fontsdir='${escapeSubtitleFilterPath(fontsDir)}'` : '')
  );
}
