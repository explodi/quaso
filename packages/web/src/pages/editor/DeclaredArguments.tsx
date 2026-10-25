// SPDX-License-Identifier: MIT
/**
 * Arguments the app passes that the English may not show (`arguments` in the CLI config):
 * what each is, beside the source, and a button per argument that writes a select block on
 * it into the translation, so that the translation can agree with it.
 */
import { Button } from "@quaso/design-system";
import type { StringArgument } from "@quaso/core";

/** The argument's select cases, `other` included: every select block needs it. */
function casesOf(argument: StringArgument): string[] {
  return [...argument.cases, "other"];
}

/** `{authorGender, select, female {text} male {text} other {text}}`. */
export function selectBlock(argument: StringArgument, text: string): string {
  const cases = casesOf(argument).map((key) => `${key} {${text}}`);
  return `{${argument.name}, select, ${cases.join(" ")}}`;
}

/** "Can vary by": each argument's name, its cases and its description, as text. */
export function ArgumentsNote({ declared }: { declared: StringArgument[] }) {
  return (
    <dl className="panel-arguments">
      {declared.map((argument) => (
        <div key={argument.name}>
          <dt>
            Can vary by <code>{argument.name}</code> ({casesOf(argument).join(", ")})
          </dt>
          <dd>{argument.description}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Vary by authorGender": writes a select block on the argument, with the selected text in
 * every case, or empty cases at the cursor.
 */
export function VaryByButtons(props: {
  declared: StringArgument[];
  /** The text selected in the input the block goes to. */
  selectedText: () => string;
  /** Inserts at the cursor of that input, replacing the selection, keeping undo. */
  insert: (text: string) => boolean;
}) {
  return props.declared.map((argument) => (
    <Button
      key={argument.name}
      size="small"
      variant="ghost"
      // The input keeps its focus and selection, as with the placeholder chips.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.insert(selectBlock(argument, props.selectedText()))}
    >
      Vary by {argument.name}
    </Button>
  ));
}
