// SPDX-License-Identifier: MIT
import {
  TextArea,
  Label,
  Select,
  Fieldset,
  Checkbox,
  H1,
  Button,
  Dialog,
  Loading,
} from "@quaso/design-system";

/** Shared, keyboard-accessible controls for the management pages. */
import { type ReactNode, useId, useState } from "react";
import type { Action } from "../lib/permissions.ts";
import { useSession } from "../lib/session.tsx";
import { useProject } from "../lib/hooks.ts";
import { useToast } from "./Toast.tsx";
import { ButtonLink } from "./Button.tsx";
import { href, useRoute } from "../lib/router.tsx";

export function Access({ action, children }: { action?: Action; children: ReactNode }) {
  const session = useSession();
  const { location } = useRoute();
  if (session.loading) return <Loading label="Checking your session…" />;
  if (!session.user) {
    return (
      <div className="page narrow management-page access-page">
        <H1 ui>Sign in to continue</H1>
        <p className="muted">Sign in to your account to open this part of the project.</p>
        <ButtonLink
          variant="primary"
          to={href("/signin", { next: location.pathname + location.search + location.hash })}
        >
          Sign in
        </ButtonLink>
      </div>
    );
  }
  if (action && !session.can(action)) {
    return (
      <div className="page narrow management-page access-page">
        <H1 ui>This page needs a different role</H1>
        <p>Ask a project administrator for access.</p>
        <ButtonLink to="/">Return to overview</ButtonLink>
      </div>
    );
  }
  return <>{children}</>;
}

export function SelectField({
  label,
  value,
  onChange,
  children,
  error,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <Label className="field-label" htmlFor={id}>
        {label}
      </Label>
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        {children}
      </Select>
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  error,
  rows = 3,
  maxLength,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  error?: string;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id} className="field-label">
        {label}
      </Label>
      <TextArea
        autoGrow={false}
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function LanguagePicker({
  value,
  onChange,
  allowAll = false,
  label = "Languages",
  error,
}: {
  value: string[] | null;
  onChange(value: string[] | null): void;
  allowAll?: boolean;
  label?: string;
  error?: string;
}) {
  const project = useProject();
  const languages = project.data?.languages ?? [];
  return (
    <Fieldset className="language-picker">
      <legend>{label}</legend>
      {allowAll && (
        <Label className="check-label">
          <Checkbox
            checked={value === null}
            onChange={(e) => onChange(e.target.checked ? null : [])}
          />
          All languages
        </Label>
      )}
      <div className="checkbox-grid">
        {languages.map((language) => (
          <Label className="check-label" key={language.tag}>
            <Checkbox
              checked={value === null || value.includes(language.tag)}
              disabled={value === null}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...(value ?? []), language.tag]
                    : (value ?? []).filter((tag) => tag !== language.tag),
                )
              }
            />
            {language.name} <span className="muted">{language.tag}</span>
          </Label>
        ))}
      </div>
      {project.loading && <Loading label="Loading languages…" />}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Fieldset>
  );
}

export function ConfirmButton({
  children,
  title,
  description,
  onConfirm,
  disabled,
  variant = "danger",
}: {
  children: ReactNode;
  title: string;
  description: ReactNode;
  onConfirm(): Promise<unknown>;
  disabled?: boolean;
  variant?: "danger" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={title}
        footer={
          <>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={variant}
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } catch {
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {children}
            </Button>
          </>
        }
      >
        <p>{description}</p>
      </Dialog>
    </>
  );
}

/** Kept only in the owning component's state; never cached or persisted. */
export function OneTimeSecret({
  value,
  title,
  onClose,
}: {
  value: string | null;
  title: string;
  onClose(): void;
}) {
  const toast = useToast();
  return (
    <Dialog
      open={value !== null}
      onClose={onClose}
      title={title}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <p>Copy this now. It is shown only once.</p>
      <TextArea
        autoGrow={false}
        className="secret-value"
        aria-label={title}
        value={value ?? ""}
        readOnly
        rows={3}
        onFocus={(e) => e.target.select()}
      />
      <Button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value ?? "");
            toast.show("Copied.");
          } catch {
            toast.show("Select the text and copy it with your keyboard.", "info");
          }
        }}
      >
        Copy
      </Button>
    </Dialog>
  );
}
