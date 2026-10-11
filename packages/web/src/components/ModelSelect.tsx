// SPDX-License-Identifier: MIT
import { Input, Select } from "@quaso/design-system";

export interface ModelSelectProps {
  id?: string;
  /** What the provider offers; empty when it can't say (no key yet, the provider is down). */
  models: string[];
  value: string;
  onChange(model: string): void;
  /** For a setting that may follow another model: the choice that leaves it blank. */
  blankLabel?: string;
  required?: boolean;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * The provider's models as a drop-down. A model the list lacks, such as a saved one the
 * provider has retired, stays in it, so that saving doesn't change it. Without a list, the
 * name is typed.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  blankLabel,
  ...attributes
}: ModelSelectProps) {
  if (models.length === 0) {
    return (
      <Input
        {...attributes}
        value={value}
        placeholder={blankLabel}
        maxLength={200}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  const unlisted = value !== "" && !models.includes(value);
  return (
    <Select {...attributes} value={value} onChange={(event) => onChange(event.target.value)}>
      {blankLabel !== undefined && <option value="">{blankLabel}</option>}
      {unlisted && <option value={value}>{value}</option>}
      {models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </Select>
  );
}
