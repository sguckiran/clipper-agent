/**
 * Prompt store: the "global agent prompt management system". Implements
 * {@link PromptStore}, backing named, versioned prompt templates on disk so prompts can be
 * edited/rolled back without code changes. Bundled defaults are seeded on first use.
 *
 * Two file formats, both `<name>.<version>.<ext>`:
 *   - `.json` — short prompts with metadata (description, declared variables).
 *   - `.md`   — long-form *skills*. The whole file is the template and the name/version come
 *               from the filename. A rating rubric is the thing most worth iterating on, and
 *               editing prose is far nicer in markdown than inside a JSON string literal.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { PromptStore, PromptTemplate } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import { dataPaths } from '../core/paths.js';
import { CLIP_SKILL_MD, SKILL_NAME, SKILL_VERSION } from '../research/skill.js';

const promptFileSchema = z.object({
  name: z.string(),
  version: z.string(),
  template: z.string(),
  description: z.string().optional(),
  variables: z.array(z.string()).optional(),
});

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Distinct `{{var}}` names referenced by a template. */
export function extractVariables(template: string): string[] {
  const set = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) {
    if (m[1]) set.add(m[1]);
  }
  return [...set];
}

/** Interpolate `{{var}}` placeholders; throws if a declared variable is missing. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  const missing = extractVariables(template).filter((v) => !(v in vars));
  if (missing.length > 0) throw new Error(`Missing prompt variables: ${missing.join(', ')}`);
  return template.replace(VAR_RE, (_, k: string) => String(vars[k]));
}

/** Bundled default prompts, seeded into an empty store. */
export const DEFAULT_PROMPTS: PromptTemplate[] = [
  {
    name: 'clip-caption-style',
    version: 'v1',
    description: 'Notes appended to the caption prompt; edit to change caption voice.',
    template:
      "Match the clip's own register: these are unfiltered streams, so blunt and crude is " +
      'fine and sanitising it makes a worse caption. Never invent names, events or drama.',
    variables: [],
  },
  {
    name: 'clip-caption',
    version: 'v1',
    description: 'Sensationalist one-line caption for a vertical clip.',
    template:
      'Write one punchy, sensationalist caption (max 12 words, no hashtags) for this clip. ' +
      'Reply ONLY JSON {"caption":"..."}.\n\nTranscript: {{transcript}}',
    variables: ['transcript'],
  },
];

function toTemplate(raw: z.infer<typeof promptFileSchema>): PromptTemplate {
  const template: PromptTemplate = {
    name: raw.name,
    version: raw.version,
    template: raw.template,
    variables: raw.variables ?? extractVariables(raw.template),
  };
  if (raw.description !== undefined) template.description = raw.description;
  return template;
}

function fileName(name: string, version: string, ext: 'json' | 'md' = 'json'): string {
  return `${name}.${version}.${ext}`;
}

/**
 * Long-form skills seeded as markdown. The whole file body is the template; name and
 * version come from the filename, so there is no frontmatter to keep in sync.
 */
export const DEFAULT_SKILLS: ReadonlyArray<{ name: string; version: string; body: string }> = [
  { name: SKILL_NAME, version: SKILL_VERSION, body: CLIP_SKILL_MD },
];

/** Parse `<name>.<version>.md` into its name and version, or undefined if it doesn't fit. */
export function parseSkillFileName(file: string): { name: string; version: string } | undefined {
  const m = /^(.+)\.([^.]+)\.md$/.exec(file);
  if (!m || !m[1] || !m[2]) return undefined;
  return { name: m[1], version: m[2] };
}

export interface PromptStoreOptions {
  /** Directory holding prompt files; falls back to <dataDir>/prompts. */
  dir?: string;
  /** Seed bundled defaults on first use (default true). */
  seedDefaults?: boolean;
}

export class FilesystemPromptStore implements PromptStore {
  private readonly dir: string;
  private readonly seed: boolean;
  private seeded = false;
  private readonly log = createLogger('prompts');

  constructor(opts: PromptStoreOptions = {}) {
    this.dir = opts.dir ?? join(dataPaths().root, 'prompts');
    this.seed = opts.seedDefaults ?? true;
  }

  private async ensureSeeded(): Promise<void> {
    if (this.seeded) return;
    await mkdir(this.dir, { recursive: true });
    if (this.seed) {
      const existing = new Set(await readdir(this.dir));
      for (const p of DEFAULT_PROMPTS) {
        const fn = fileName(p.name, p.version);
        if (!existing.has(fn)) {
          await writeFile(join(this.dir, fn), JSON.stringify(p, null, 2), 'utf8');
          this.log.info({ name: p.name, version: p.version }, 'seeded default prompt');
        }
      }
      // Skills are seeded, never overwritten: an edited skill on disk is the source of
      // truth and a later upgrade must not silently discard the user's tuning.
      for (const s of DEFAULT_SKILLS) {
        const fn = fileName(s.name, s.version, 'md');
        if (!existing.has(fn)) {
          await writeFile(join(this.dir, fn), s.body, 'utf8');
          this.log.info({ name: s.name, version: s.version }, 'seeded default skill');
        }
      }
    }
    this.seeded = true;
  }

  private async readAll(): Promise<PromptTemplate[]> {
    await this.ensureSeeded();
    const files = await readdir(this.dir);
    const templates: PromptTemplate[] = [];
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      const raw = await readFile(join(this.dir, f), 'utf8');
      templates.push(toTemplate(promptFileSchema.parse(JSON.parse(raw))));
    }
    for (const f of files.filter((n) => n.endsWith('.md'))) {
      const parsed = parseSkillFileName(f);
      if (!parsed) continue;
      const body = await readFile(join(this.dir, f), 'utf8');
      templates.push({
        name: parsed.name,
        version: parsed.version,
        template: body,
        variables: extractVariables(body),
        description: 'skill (markdown)',
      });
    }
    return templates;
  }

  async list(): Promise<PromptTemplate[]> {
    return this.readAll();
  }

  async get(name: string, version?: string): Promise<PromptTemplate> {
    const matches = (await this.readAll()).filter((t) => t.name === name);
    if (matches.length === 0) throw new Error(`Prompt not found: ${name}`);
    if (version) {
      const exact = matches.find((t) => t.version === version);
      if (!exact) throw new Error(`Prompt not found: ${name}@${version}`);
      return exact;
    }
    // Latest version (numeric-aware sort, e.g. v10 > v2).
    return matches.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    )[0]!;
  }

  async render(
    name: string,
    vars: Record<string, string | number>,
    version?: string,
  ): Promise<string> {
    const tpl = await this.get(name, version);
    return interpolate(tpl.template, vars);
  }
}

export function createPromptStore(opts?: PromptStoreOptions): PromptStore {
  return new FilesystemPromptStore(opts);
}
