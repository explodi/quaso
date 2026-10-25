// SPDX-License-Identifier: MIT
/**
 * Arguments the app passes that the English may not show (`arguments` in the CLI config):
 * what each is, beside the source, and a button per argument that writes a select block on
 * it into the translation, so that the translation can agree with it.
 */
import { Button } from "@quaso/design-system";
import type { IcuField, StringArgument } from "@quaso/core";

/** The argument's select cases, `other` included: every select block needs it. */
function casesOf(argument: StringArgument): string[] {
  return [...argument.cases, "other"];
}

/** `{authorGender, select, female {text} male {text} other {text}}`. */
export function selectBlock(argument: StringArgument, text: string): string {
  const cases = casesOf(argument).map((key) => `${key} {${text}}`);
  return `{${argument.name}, select, ${cases.join(" ")}}`;
}

/** A character no translation has: it marks where a field's selection was. */
const MARK = "";

/**
 * The translation with a case field's selection varied by an argument. The field is written
 * with marks around the selection, so that the selected text comes out as ICU, quoted as
 * the field writes it, and goes into every case. Null if the text has the mark already.
 */
export function varyFieldSelection(
  write: (field: IcuField, text: string) => string,
  field: IcuField,
  selection: { start: number; end: number },
  argument: StringArgument,
): string | null {
  const { start, end } = selection;
  const text = field.text;
  const marked = text.slice(0, start) + MARK + text.slice(start, end) + MARK + text.slice(end);
  const parts = write(field, marked).split(MARK);
  if (parts.length !== 3) return null;
  const [before, selected, after] = parts;
  return before + selectBlock(argument, selected) + after;
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

/** "Vary by authorGender", for each argument. */
export function VaryByButtons(props: {
  declared: StringArgument[];
  /** Writes a select block on the argument, around the selected text. */
  onVary: (argument: StringArgument) => boolean;
}) {
  return props.declared.map((argument) => (
    <Button
      key={argument.name}
      size="small"
      variant="ghost"
      // The input keeps its focus and selection, as with the placeholder chips.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onVary(argument)}
    >
      Vary by {argument.name}
    </Button>
  ));
}
