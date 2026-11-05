// SPDX-License-Identifier: MIT
import { Button, Input, Label, Loading } from "@quaso/design-system";
import {
  MAX_LENGTH_LIMIT,
  type StringsPage,
  type StringSummary,
  UpdateStringRequest,
} from "@quaso/core";
import { useState } from "react";
import { errorMessage, request } from "../lib/api.ts";
import { queryCache, useQuery } from "../lib/data.ts";
import { fieldError, validated } from "../lib/forms.ts";
import { sourcePreview, stringName } from "../lib/format.ts";
import { useDebounced } from "../lib/hooks.ts";
import { limitDrafts, useSettingsDrafts } from "../lib/settingsDrafts.ts";
import "../styles/length-limits.css";

function LimitRow({
  string,
  draft,
  busy,
  change,
  refresh,
}: {
  string: StringSummary;
  draft: string | undefined;
  busy: boolean;
  change(value: string | undefined): void;
  refresh(): Promise<unknown>;
}) {
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const stored = string.maxLength?.toString() ?? "";
  const value = draft ?? stored;
  const dirty = value !== stored;
  const name = stringName(string.file, string.key);
  const errorId = `limit-error-${string.id}`;
  const validationError = fieldError(error, "maxLength");
  return (
    <li className="length-limit-row">
      <div className="length-limit-source">
        <p className="length-limit-path">{name}</p>
        <p className="length-limit-preview">{sourcePreview(string.source)}</p>
      </div>
      {string.maxLengthLocked ? (
        <div className="length-limit-locked">
          <strong>
            {string.maxLength === null ? "No limit" : `${string.maxLength} characters`}
          </strong>
          <span>From CLI configuration</span>
        </div>
      ) : (
        <form
          className="length-limit-form"
          aria-label={`Length limit for ${name}`}
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !dirty) return;
            setError(undefined);
            setSaved(false);
            try {
              const saved = await limitDrafts.save(String(string.id), value, async () => {
                await request(`/strings/${string.id}`, {
                  method: "PATCH",
                  body: validated(UpdateStringRequest, {
                    maxLength: value === "" ? null : Number(value),
                  }),
                });
                await Promise.all(
                  ["settings-strings", "strings", "string"].map((key) =>
                    queryCache.invalidate([key]),
                  ),
                );
                await refresh();
              });
              setSaved(saved);
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <Label>
            <span className="sr-only">Maximum characters for {name}</span>
            <Input
              type="number"
              min="1"
              max={MAX_LENGTH_LIMIT}
              step="1"
              placeholder="No limit"
              value={value}
              disabled={busy}
              aria-invalid={validationError ? true : undefined}
              aria-describedby={error === undefined ? "length-limits-help" : errorId}
              onChange={(event) => {
                change(event.target.value === stored ? undefined : event.target.value);
                setSaved(false);
                setError(undefined);
              }}
            />
          </Label>
          <Button type="submit" size="small" variant="primary" disabled={!dirty} busy={busy}>
            Save
          </Button>
          {dirty && (
            <Button
              size="small"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                change(undefined);
                setError(undefined);
              }}
            >
              Discard
            </Button>
          )}
          {saved && !dirty && (
            <span role="status" className="length-limit-saved">
              Saved
            </span>
          )}
          {error !== undefined && (
            <p id={errorId} role="alert" className="field-error">
              {validationError ?? errorMessage(error)}
            </p>
          )}
        </form>
      )}
    </li>
  );
}

export function LengthLimits({ language }: { language?: string }) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search, 200);
  const [cursor, setCursor] = useState<string | undefined>();
  const { drafts, saving } = useSettingsDrafts(limitDrafts);
  const strings = useQuery(
    language ? ["settings-strings", language, query, cursor] : null,
    ({ fresh }) =>
      request<StringsPage>("/strings", {
        query: { language, q: query, cursor, limit: 30 },
        fresh,
      }),
  );
  return (
    <section className="length-limits">
      <div className="length-limits-toolbar">
        <Label className="field">
          <span className="field-label">Find a string</span>
          <Input
            type="search"
            placeholder="Search keys and source or translated text"
            maxLength={200}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setCursor(undefined);
            }}
          />
        </Label>
        <p id="length-limits-help" className="muted">
          Maximum characters per translation. Leave blank for no limit. Limits from CLI
          configuration must be changed there and uploaded.
        </p>
      </div>
      {drafts.size > 0 && (
        <p className="muted" role="status">
          {drafts.size} unsaved {drafts.size === 1 ? "limit" : "limits"}. Drafts stay here while you
          browse.
        </p>
      )}
      {!language && <p>Add a language to browse the strings.</p>}
      {strings.loading && <Loading />}
      {strings.error !== undefined && <p role="alert">{errorMessage(strings.error)}</p>}
      {strings.data && (
        <>
          <p className="muted" role="status">
            {strings.data.total} matching strings
          </p>
          {strings.data.strings.length === 0 && <p>No matching strings. Try a different search.</p>}
          <ul className="length-limit-list" aria-label="String length limits">
            {strings.data.strings.map((string) => (
              <LimitRow
                key={string.id}
                string={string}
                draft={drafts.get(String(string.id))}
                busy={saving.has(String(string.id))}
                refresh={strings.refresh}
                change={(value) => limitDrafts.change(String(string.id), value)}
              />
            ))}
          </ul>
          {(cursor || strings.data.nextCursor) && (
            <nav className="length-limits-pagination" aria-label="String pages">
              <Button disabled={!cursor} onClick={() => setCursor(undefined)}>
                First page
              </Button>
              <Button
                disabled={!strings.data.nextCursor}
                onClick={() => setCursor(strings.data?.nextCursor ?? undefined)}
              >
                Next page
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
