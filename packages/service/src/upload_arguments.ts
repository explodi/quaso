// SPDX-License-Identifier: MIT
import { type ArgumentDeclaration, argumentResolver } from "@quaso/core";
import { toJson } from "./db.ts";
import type { Statement } from "./ports.ts";

/** An active, translatable string of an uploaded file, with the arguments it has now. */
export type ArgumentTarget = {
  id: number;
  path: string;
  display_key: string;
  /** JSON `StringArgument[]`, or null for none. */
  arguments: string | null;
};

/**
 * The arguments each string of the uploaded files receives from the config's declarations,
 * stored with the string (null for none), without I/O. They are kept whatever the syntax,
 * and only apply with ICU MessageFormat on, which the warnings say.
 */
export function planUploadArguments(
  declarations: readonly ArgumentDeclaration[],
  targets: readonly ArgumentTarget[],
  options: { icu: boolean; partial: boolean; at: number },
): {
  statements: Statement[];
  changes: { id: number; arguments: string | null }[];
  warnings: string[];
} {
  const argumentsFor = argumentResolver(declarations);
  const used = new Set<string>();
  const changes: { id: number; arguments: string | null }[] = [];
  for (const target of targets) {
    const received = argumentsFor(target.path, target.display_key);
    for (const argument of received) used.add(argument.name);
    const stored = received.length === 0 ? null : toJson(received);
    if (stored !== target.arguments) changes.push({ id: target.id, arguments: stored });
  }
  const warnings: string[] = [];
  if (declarations.length > 0 && !options.icu) {
    warnings.push(
      "The config declares arguments, which only apply with ICU MessageFormat on " +
        "(Settings → Placeholders); the strings keep them for when it is",
    );
  }
  // A partial upload sends some files only: an argument may be for the others.
  const unused = options.partial ? [] : declarations.filter((item) => !used.has(item.name));
  for (const declaration of unused) {
    warnings.push(
      `The argument ${declaration.name} applies to no string, so it does nothing: ` +
        "correct its files and keys, or remove it",
    );
  }
  return {
    changes,
    statements: changes.map((change) => ({
      sql: "UPDATE strings SET arguments = ?, updated_at = ? WHERE id = ?",
      params: [change.arguments, options.at, change.id],
    })),
    warnings,
  };
}
