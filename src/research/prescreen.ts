/**
 * Free, deterministic **content** prescreen over transcript windows.
 *
 * A long VOD produces thousands of windows and we only pay to LLM-rate a few hundred
 * of them. This module decides which ones, using nothing but the text — so the choice
 * is made on *what was said*, never on how loud it was. That distinction is the whole
 * point: a deadpan, quiet, completely unhinged tangent has to be able to reach the
 * rater, and under a loudness gate it never could.
 *
 * Three signals, all cheap:
 *   1. **Markers** — vocabulary that marks the kind of talk that clips (crude, shocking,
 *      confessional, argumentative, absurd), minus vocabulary that marks stream admin.
 *   2. **Novelty** — inverse document frequency against the source's *own* transcript.
 *      Words that are rare for this streamer flag the off-topic tangent; this needs no
 *      word list at all and adapts to whatever a given stream is normally about.
 *   3. **Delivery** — question/exclamation density, a proxy for riffing and reactions.
 */

/**
 * Terms that mark clip-worthy talk. Matched as whole words, case-insensitively, so
 * inflections are listed explicitly where they matter — a prefix match would fire
 * "ass" on "assume" and quietly poison the ranking.
 *
 * This is intentionally blunt vocabulary: these streams are crude and the crude parts
 * are the product. Extend per-streamer with CLIPPER_SPICE_WORDS (inside jokes, names,
 * recurring bits) rather than editing this list.
 */
export const SPICE_MARKERS: readonly string[] = [
  // profanity / crude
  'fuck',
  'fucked',
  'fucking',
  'fucker',
  'shit',
  'shitting',
  'bullshit',
  'bitch',
  'bastard',
  'damn',
  'goddamn',
  'hell',
  'crap',
  'piss',
  'pissed',
  'dick',
  'cock',
  'balls',
  'nuts',
  'butt',
  'booty',
  'naked',
  'nude',
  'horny',
  'sex',
  'sexual',
  'porn',
  'virgin',
  'condom',
  'toilet',
  'fart',
  'farted',
  'puke',
  'puked',
  'vomit',
  'throw up',
  'threw up',
  'diarrhea',
  // shock / stakes
  'insane',
  'unhinged',
  'deranged',
  'psycho',
  'feral',
  'cursed',
  'disgusting',
  'nasty',
  'gross',
  'horrible',
  'traumatized',
  'illegal',
  'arrested',
  'cops',
  'police',
  'jail',
  'prison',
  'court',
  'sued',
  'banned',
  'cancelled',
  'exposed',
  'caught',
  'cheated',
  'stole',
  'robbed',
  'fight',
  'fought',
  'punched',
  'stabbed',
  'died',
  'dead',
  'death',
  'kill',
  'killed',
  'blood',
  'hospital',
  'ambulance',
  'drunk',
  'wasted',
  'weed',
  'high',
  'drugs',
  'overdosed',
  // confession / story openers
  'i swear',
  'swear to god',
  'no cap',
  'deadass',
  'lowkey',
  'i admit',
  'confession',
  'i used to',
  'one time i',
  'when i was',
  'my ex',
  'ex girlfriend',
  'ex boyfriend',
  'hooked up',
  'divorce',
  'therapy',
  'nobody knows',
  'never told',
  'true story',
  'craziest',
  'weirdest',
  'worst',
  'dumbest',
  // hypotheticals / riffs / reactions
  'would you rather',
  'imagine if',
  'what if',
  'hypothetically',
  'be honest',
  'have you ever',
  'lol',
  'lmao',
  'haha',
  'bruh',
  'bro',
  'what the',
  'oh my god',
  'wait what',
  'hold on',
  'excuse me',
  'are you serious',
  'no way',
  'shut up',
  'stop it',
  'weird',
  'wild',
  'crazy',
  'literally',
  'actually',
];

/**
 * Terms that mark stream admin / non-content. These down-rank a window: they are the
 * things that fill hours of a VOD and none of them ever make a clip. Extend with
 * CLIPPER_FILLER_WORDS.
 */
export const FILLER_MARKERS: readonly string[] = [
  'subscribe',
  'follow me',
  'like the video',
  'smash that',
  'donation',
  'donated',
  'tier one',
  'tier three',
  'prime sub',
  'resub',
  'bits',
  'raid',
  'raiding',
  'hosting',
  'sponsor',
  'sponsored',
  'promo code',
  'discount code',
  'link in',
  'link below',
  'check the description',
  'giveaway',
  'welcome back',
  'good morning chat',
  'how is everyone',
  'can you hear me',
  'is my mic',
  'mic check',
  'audio check',
  'stream is',
  'brb',
  'be right back',
  'one more game',
  'queue up',
  'lobby',
  'respawn',
  'reload',
  'heal me',
  'nice shot',
  'gg',
  'ggs',
  'well played',
  // Pure hype. Loud, marker-adjacent, and never a clip on its own.
  'lets go',
  "let's go",
  'lets gooo',
  "that's what i'm talking about",
  'thats what im talking about',
  'my bad',
  'lag',
  'ping',
  'fps',
];

/** Very common words excluded from the novelty signal. */
const STOPWORDS = new Set([
  'that',
  'this',
  'with',
  'have',
  'they',
  'what',
  'just',
  'like',
  'know',
  'been',
  'were',
  'them',
  'then',
  'than',
  'when',
  'your',
  'from',
  'there',
  'about',
  'would',
  'could',
  'should',
  'because',
  'gonna',
  'wanna',
  'really',
  'right',
  'yeah',
  'okay',
  'thing',
  'think',
  'going',
  'want',
  'said',
  'says',
  'here',
  'over',
  'into',
  'some',
  'very',
  'much',
  'more',
  'good',
  'time',
  'people',
  'also',
  'even',
  'these',
  'those',
  'their',
  'where',
  'which',
]);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Escape a literal for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a marker list into one case-insensitive whole-word alternation. Multi-word
 * phrases work as-is; `\b` around the group keeps "ass" out of "assume".
 */
export function compileMarkers(markers: readonly string[]): RegExp {
  const sorted = [...markers].sort((a, b) => b.length - a.length).map(escapeRe);
  return new RegExp(`\\b(?:${sorted.join('|')})\\b`, 'gi');
}

/** Count whole-word marker hits in a text. */
export function countMarkers(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/** Lowercased content words (length >= 4, non-stopword) used for the novelty signal. */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/**
 * Inverse document frequency of every content word across the source's own windows.
 * Rare-for-this-stream words are what a topic tangent looks like from the outside.
 */
export function buildIdf(docs: readonly string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const w of new Set(contentWords(doc))) {
      df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const n = Math.max(docs.length, 1);
  const idf = new Map<string, number>();
  for (const [w, count] of df) idf.set(w, Math.log(n / count));
  return idf;
}

/**
 * Mean IDF of a window's distinct words, mapped to 0–100. Normalized by log(N) so the
 * scale is comparable across sources of different lengths.
 */
export function noveltyScore(text: string, idf: Map<string, number>, docCount: number): number {
  const words = [...new Set(contentWords(text))];
  if (words.length === 0) return 0;
  const maxIdf = Math.log(Math.max(docCount, 2));
  const mean = words.reduce((acc, w) => acc + (idf.get(w) ?? maxIdf), 0) / words.length;
  return clamp((mean / maxIdf) * 100, 0, 100);
}

/**
 * Question density mapped to 0–100; `perMinuteFor100` marks a busy riff.
 *
 * Questions only, deliberately — exclamation marks measure *delivery*, and counting them
 * scores "LETS GO! YES! LETS GO!" as a top candidate, which is the loudness bias this
 * module exists to remove. A question is a content signal: hypotheticals, interrogations
 * and "wait, why would you do that?" are where these streams go off the rails.
 */
export function deliveryScore(text: string, durationSec: number, perMinuteFor100 = 6): number {
  const hits = (text.match(/\?/g) ?? []).length;
  const perMinute = hits / Math.max(durationSec / 60, 1 / 60);
  return clamp((perMinute / perMinuteFor100) * 100, 0, 100);
}

/**
 * Share of distinct words, mapped to 0–100. Chanting and hype ("let's go, let's go, YES,
 * YES") is loud, marker-rich and says nothing; low variety is what that looks like in text.
 */
export function varietyScore(text: string): number {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length < 4) return 0;
  return clamp((new Set(words).size / words.length) * 100, 0, 100);
}

/** Marker hits per minute mapped to 0–100; `perMinuteFor100` marks dense spicy talk. */
export function markerScore(hits: number, durationSec: number, perMinuteFor100 = 10): number {
  const perMinute = hits / Math.max(durationSec / 60, 1 / 60);
  return clamp((perMinute / perMinuteFor100) * 100, 0, 100);
}

export interface PrescreenOptions {
  /** Extra spice terms appended to {@link SPICE_MARKERS}. */
  spiceWords?: readonly string[];
  /** Extra filler terms appended to {@link FILLER_MARKERS}. */
  fillerWords?: readonly string[];
}

export interface PrescreenBreakdown {
  score: number;
  marker: number;
  novelty: number;
  delivery: number;
  variety: number;
  fillerHits: number;
}

/**
 * A reusable prescreen bound to one source's vocabulary. Build it once per detect()
 * run (the IDF table depends on all the windows), then score each window.
 */
export interface Prescreen {
  score(text: string, durationSec: number): PrescreenBreakdown;
}

/**
 * Build a prescreen over a source's windows. Weights are fixed rather than configurable
 * because this stage only chooses *who gets rated* — the LLM decides what actually wins,
 * so precision here is not worth another five env vars.
 */
export function createPrescreen(
  windowTexts: readonly string[],
  opts: PrescreenOptions = {},
): Prescreen {
  const spiceRe = compileMarkers([...SPICE_MARKERS, ...(opts.spiceWords ?? [])]);
  const fillerRe = compileMarkers([...FILLER_MARKERS, ...(opts.fillerWords ?? [])]);
  const idf = buildIdf(windowTexts);
  const docCount = windowTexts.length;

  return {
    score(text, durationSec) {
      const marker = markerScore(countMarkers(text, spiceRe), durationSec);
      const novelty = noveltyScore(text, idf, docCount);
      const delivery = deliveryScore(text, durationSec);
      const variety = varietyScore(text);
      const fillerHits = countMarkers(text, fillerRe);
      // Filler is a hard signal — a sponsor read is never a clip regardless of how novel
      // its vocabulary looks — so it subtracts a flat chunk per hit. Variety is a gate
      // rather than a bonus: it scales everything else down, because a window that repeats
      // itself has nothing to rate no matter how spicy its words are.
      const raw =
        (0.5 * marker + 0.3 * novelty + 0.2 * delivery) * (0.4 + 0.6 * (variety / 100)) -
        12 * fillerHits;
      return { score: clamp(raw, 0, 100), marker, novelty, delivery, variety, fillerHits };
    },
  };
}
