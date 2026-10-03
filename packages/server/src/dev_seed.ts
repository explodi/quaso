// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The development seed (design §5.13): the demo project from `examples/demo-game/`,
 * uploaded and partly translated, and a development API key. `bun run dev` runs it once,
 * on a new database, through `quaso seed-dev`.
 */
import {
  type FileMapping,
  type ImportResult,
  parse,
  QuasoConfig,
  type TokenScope,
  type UploadResult,
} from "@quaso/core";
import { type Actor, ANONYMOUS, type ServiceApi, SYSTEM } from "@quaso/service";
import { glob } from "node:fs/promises";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join, relative, sep as SEPARATOR } from "node:path";

/** `examples/demo-game/` in the repository. */
export function demoDir(): string {
  return fromFileUrl(new URL("../../../examples/demo-game/", import.meta.url));
}

/** The demo's translations to import, and how. */
export const DEMO_IMPORTS: { language: string; as: "green" | "blue" }[] = [
  { language: "de", as: "blue" },
  { language: "pl", as: "green" },
  { language: "fr", as: "green" },
];

export const DEV_KEY: { name: string; scope: TokenScope } = {
  name: "Development",
  scope: "upload",
};

/** A project's files, read as the CLI would: sources, and translations by language. */
export interface ProjectFiles {
  config: QuasoConfig;
  sources: { path: string; repoPath: string; content: string }[];
  translations: Map<string, { path: string; content: string }[]>;
}

/** Reads `quaso.config.json` and the files it points to, below `dir`. */
export async function readProjectFiles(dir: string): Promise<ProjectFiles> {
  const config = parse(
    QuasoConfig,
    JSON.parse(await fs.readFile(join(dir, "quaso.config.json"), "utf8")),
  );
  const sources: ProjectFiles["sources"] = [];
  const translations = new Map<string, { path: string; content: string }[]>();
  for (const mapping of config.files) {
    for (const path of await sourcePaths(dir, mapping)) {
      sources.push({
        path,
        repoPath: [globBase(mapping.source), path].filter(Boolean).join("/"),
        content: await fs.readFile(join(dir, globBase(mapping.source), path), "utf8"),
      });
      for (const language of config.languages) {
        const folder = config.languageMapping?.[language] ?? language;
        const target = mapping.translation.replaceAll("{lang}", folder).replaceAll("{path}", path);
        const content = await readIfExists(join(dir, target));
        if (content === null) continue;
        if (!translations.has(language)) translations.set(language, []);
        translations.get(language)!.push({ path, content });
      }
    }
  }
  return { config, sources, translations };
}

/** The demo volunteer: a contributor for French, with suggestions waiting for review. */
export const DEMO_VOLUNTEER = { email: "volunteer@example.com", displayName: "Demo Volunteer" };

/** The suggestions the demo volunteer sent (French, `menus.json`). */
export const DEMO_SUGGESTIONS = [
  { key: "main.newGame", value: "Commencer une nouvelle partie" },
  { key: "options.music", value: "Volume de la musique" },
];

/**
 * People for the development instance (design §5.13): the developer account (an
 * administrator the one-click sign-in uses), and a demo volunteer with pending suggestions,
 * so the review screens have something to show. Needs a development service (`dev`).
 */
export async function seedPeople(service: ServiceApi): Promise<{ developerId: number }> {
  const developer = await service.ensureDevAccount(SYSTEM, {});
  const admin: Actor = { type: "user", userId: developer.id };
  // Nobody knows this password: the volunteer only exists to have sent suggestions.
  const password = crypto.randomUUID() + crypto.randomUUID();
  const volunteer = await service.signUp(ANONYMOUS, { ...DEMO_VOLUNTEER, password });
  await service.signOut(SYSTEM, { sessionId: volunteer.sessionId });
  await service.requestVolunteer(
    { type: "user", userId: volunteer.user.id },
    {
      languages: ["fr"],
      message: "I'd like to help with the French translation.",
    },
  );
  await service.reviewVolunteer(admin, {
    userId: volunteer.user.id,
    approve: true,
    languages: ["fr"],
  });
  const actor: Actor = { type: "user", userId: volunteer.user.id };
  const strings = await service.listStrings(ANONYMOUS, {
    language: "fr",
    file: "menus.json",
    limit: 500,
  });
  for (const { key, value } of DEMO_SUGGESTIONS) {
    const string = strings.strings.find((s) => s.key === key);
    if (!string) continue;
    await service.suggest(actor, {
      id: string.id,
      language: "fr",
      kind: string.translation ? "correction" : "translation",
      value,
      baseRevision: string.translation?.revision ?? 0,
    });
  }
  return { developerId: developer.id };
}

/**
 * Uploads the demo project, imports its translations and creates the development key; with
 * `people` (what `seed-dev` does, on a development service), also the developer account
 * and a demo volunteer with pending suggestions (`seedPeople`).
 */
export async function seedDemo(
  service: ServiceApi,
  dir = demoDir(),
  options: { people?: boolean } = {},
): Promise<{ apiKey: string; upload: UploadResult; imports: ImportResult[] }> {
  const { config, sources, translations } = await readProjectFiles(dir);
  const upload = await service.upload(SYSTEM, {
    files: sources,
    sourceLanguage: config.sourceLanguage,
    languages: config.languages,
    limits: config.limits,
    pluralExclusions: config.pluralExclusions,
  });
  const imports: ImportResult[] = [];
  for (const { language, as } of DEMO_IMPORTS) {
    const files = translations.get(language);
    if (!files) continue;
    // The demo's names ("Quaso Quest") stay as they are in every language.
    imports.push(
      await service.importTranslations(SYSTEM, { language, files, as, keepIdentical: true }),
    );
  }
  const token = await service.createApiToken(SYSTEM, DEV_KEY);
  if (options.people) await seedPeople(service);
  return { apiKey: token.secret, upload, imports };
}

/** Source paths below the glob's base folder, with `/` separators, sorted. */
async function sourcePaths(dir: string, mapping: FileMapping): Promise<string[]> {
  const base = join(dir, globBase(mapping.source));
  const paths: string[] = [];
  for await (const entry of glob(mapping.source, {
    cwd: dir,
    withFileTypes: true,
    exclude: mapping.exclude,
  })) {
    if (entry.isFile())
      paths.push(relative(base, join(entry.parentPath, entry.name)).split(SEPARATOR).join("/"));
  }
  return paths.sort();
}

/** The folder where a glob starts: `src/locales/en` for `src/locales/en/**\/*.json`. */
export function globBase(pattern: string): string {
  const parts = pattern.split("/");
  const first = parts.findIndex((part) => /[*?[\]{}!]/.test(part));
  return parts.slice(0, first === -1 ? parts.length - 1 : first).join("/");
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
