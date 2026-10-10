// SPDX-License-Identifier: MIT
import {
  TextArea,
  Fieldset,
  Label,
  Checkbox,
  Input,
  Details,
  Summary,
  Select,
  A,
  H2,
  H3,
  H1,
  Button,
  Loading,
} from "@quaso/design-system";
import { createContext, type ReactNode, useContext, useState } from "react";
import {
  AddLanguageRequest,
  type ApiTokensResult,
  CreateApiTokenRequest,
  type CreatedApiToken,
  languageName,
  type LanguageSettings,
  type LlmSettings,
  PLURAL_CATEGORIES,
  PROMPT_PLACEHOLDERS,
  type SettingsResult,
  type SecretsResult,
  type SecretStatus,
  type LlmTestResult,
  type ManagedSecretName,
  SetSecretRequest,
  type StringsPage,
  type StringSummary,
  UpdateFileRequest,
  UpdateLanguageRequest,
  UpdateSettingsRequest,
  UpdateStringRequest,
} from "@quaso/core";
import { Access, ConfirmButton, LanguagePicker, OneTimeSecret } from "../components/Management.tsx";
import { apiUrl, errorMessage, request } from "../lib/api.ts";
import { queryCache, useQuery } from "../lib/data.ts";
import { fieldError, validated } from "../lib/forms.ts";
import { href, Link, useRoute } from "../lib/router.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { AdminDetails } from "./Admin.tsx";
import { LanguageRequestsAdmin } from "../components/LanguageRequests.tsx";

const FormError = createContext<unknown>(undefined);
function SaveForm({
  title,
  children,
  save,
  label = "Save",
}: {
  title: string;
  children: ReactNode;
  save(): Promise<unknown>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  return (
    <section className="management-section">
      <H2 ui>{title}</H2>
      <form
        onChange={() => setSaved(false)}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          setSaved(false);
          try {
            await save();
            // Remounted sections read these snapshots; constraints also appear in the editor.
            await Promise.all(
              ["project", "settings", "settings-strings", "strings", "string"].map((key) =>
                queryCache.invalidate([key]),
              ),
            );
            setSaved(true);
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormError.Provider value={error}>
          <Fieldset disabled={busy} className="settings-fields">
            {children}
          </Fieldset>
        </FormError.Provider>
        {error !== undefined && (
          <p role="alert" className="field-error">
            {errorMessage(error)}
          </p>
        )}
        <div className="settings-save">
          <Button type="submit" variant="primary" busy={busy}>
            {label}
          </Button>
          {saved && <p role="status">Saved.</p>}
        </div>
      </form>
    </section>
  );
}
function Field({ label, path, children }: { label: string; path: string; children: ReactNode }) {
  const error = fieldError(useContext(FormError), path);
  return (
    <Label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </Label>
  );
}
function Check({
  label,
  checked,
  change,
}: {
  label: string;
  checked: boolean;
  change(value: boolean): void;
}) {
  return (
    <Label className="check-label">
      <Checkbox checked={checked} onChange={(e) => change(e.target.checked)} />
      {label}
    </Label>
  );
}
function patchSettings(body: unknown) {
  return request("/settings", { method: "PATCH", body: validated(UpdateSettingsRequest, body) });
}

function General({ data }: { data: SettingsResult }) {
  const [name, setName] = useState(data.settings.name);
  const [description, setDescription] = useState(data.settings.description);
  const [logoUrl, setLogoUrl] = useState(data.settings.logoUrl ?? "");
  const [links, setLinks] = useState(data.settings.links);
  const [syntax, setSyntax] = useState(data.settings.syntax);
  const extra = syntax.extra ?? [];
  const setExtra = (index: number, delimiters: { prefix: string; suffix: string }) =>
    setSyntax({ ...syntax, extra: extra.map((item, j) => (j === index ? delimiters : item)) });
  const optional = syntax.optional ?? [];
  const setOptional = (index: number, entry: { placeholder: string; languages: string[] }) =>
    setSyntax({
      ...syntax,
      optional: optional.map((item, j) => (j === index ? entry : item)),
    });
  return (
    <>
      <SaveForm
        title="General"
        save={() => patchSettings({ name, description, logoUrl: logoUrl || null, links })}
      >
        <Field label="Project name" path="name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label="Description" path="description">
          <TextArea
            autoGrow={false}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>
        <Field label="Logo URL" path="logoUrl">
          <Input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
        </Field>
        <Fieldset>
          <legend>Project links</legend>
          {links.map((link, i) => (
            <div className="record-card" key={i}>
              <Field label={`Link ${i + 1} label`} path={`links.${i}.label`}>
                <Input
                  value={link.label}
                  onChange={(e) =>
                    setLinks(links.map((l, j) => (i === j ? { ...l, label: e.target.value } : l)))
                  }
                  required
                />
              </Field>
              <Field label={`Link ${i + 1} URL`} path={`links.${i}.url`}>
                <Input
                  type="url"
                  value={link.url}
                  onChange={(e) =>
                    setLinks(links.map((l, j) => (i === j ? { ...l, url: e.target.value } : l)))
                  }
                  required
                />
              </Field>
              <Button onClick={() => setLinks(links.filter((_, j) => i !== j))}>
                Remove link {i + 1}
              </Button>
            </div>
          ))}
          <Button
            disabled={links.length >= 20}
            onClick={() => setLinks([...links, { label: "", url: "" }])}
          >
            Add link
          </Button>
        </Fieldset>
      </SaveForm>
      <SaveForm title="Placeholder syntax" save={() => patchSettings({ syntax })}>
        <p>Changing the syntax rechecks translations. Use the same delimiters as your app.</p>
        <Field label="Prefix" path="syntax.prefix">
          <Input
            value={syntax.prefix}
            required
            maxLength={10}
            onChange={(e) => setSyntax({ ...syntax, prefix: e.target.value })}
          />
        </Field>
        <Field label="Suffix" path="syntax.suffix">
          <Input
            value={syntax.suffix}
            required
            maxLength={10}
            onChange={(e) => setSyntax({ ...syntax, suffix: e.target.value })}
          />
        </Field>
        <Fieldset>
          <legend>Other placeholders</legend>
          <p>
            Delimiters of placeholders your app fills in itself, such as <code>{"{"}</code> and{" "}
            <code>{"}"}</code> for <code>{"{name}"}</code>. They are checked and kept like the
            others.
          </p>
          {extra.map((delimiters, i) => (
            <div className="record-card" key={i}>
              <Field label={`Other placeholder ${i + 1} prefix`} path={`syntax.extra.${i}.prefix`}>
                <Input
                  value={delimiters.prefix}
                  required
                  maxLength={10}
                  onChange={(e) => setExtra(i, { ...delimiters, prefix: e.target.value })}
                />
              </Field>
              <Field label={`Other placeholder ${i + 1} suffix`} path={`syntax.extra.${i}.suffix`}>
                <Input
                  value={delimiters.suffix}
                  required
                  maxLength={10}
                  onChange={(e) => setExtra(i, { ...delimiters, suffix: e.target.value })}
                />
              </Field>
              <Button
                onClick={() => setSyntax({ ...syntax, extra: extra.filter((_, j) => i !== j) })}
              >
                Remove other placeholder {i + 1}
              </Button>
            </div>
          ))}
          <Button
            disabled={extra.length >= 10}
            onClick={() => setSyntax({ ...syntax, extra: [...extra, { prefix: "", suffix: "" }] })}
          >
            Add other placeholder
          </Button>
        </Fieldset>
        <Fieldset>
          <legend>Placeholders some languages leave out</legend>
          <p>
            A placeholder that some languages have no use for, such as an English article filled in
            as <code>{"{article}"}</code>, in languages without articles. Those languages may leave
            it out; elsewhere it is required as usual.
          </p>
          {optional.map((entry, i) => (
            <div className="record-card" key={i}>
              <Field
                label={`Optional placeholder ${i + 1}`}
                path={`syntax.optional.${i}.placeholder`}
              >
                <Input
                  value={entry.placeholder}
                  required
                  maxLength={100}
                  onChange={(e) => setOptional(i, { ...entry, placeholder: e.target.value })}
                />
              </Field>
              <Field
                label={`Languages that may leave out placeholder ${i + 1}, such as pl, tr, ja`}
                path={`syntax.optional.${i}.languages`}
              >
                <Input
                  value={entry.languages.join(", ")}
                  required
                  onChange={(e) =>
                    setOptional(i, {
                      ...entry,
                      languages: e.target.value
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter((tag) => tag !== ""),
                    })
                  }
                />
              </Field>
              <Button
                onClick={() =>
                  setSyntax({ ...syntax, optional: optional.filter((_, j) => i !== j) })
                }
              >
                Remove optional placeholder {i + 1}
              </Button>
            </div>
          ))}
          <Button
            disabled={optional.length >= 50}
            onClick={() =>
              setSyntax({ ...syntax, optional: [...optional, { placeholder: "", languages: [] }] })
            }
          >
            Add optional placeholder
          </Button>
        </Fieldset>
      </SaveForm>
    </>
  );
}

const PLACEHOLDER_HELP: Record<(typeof PROMPT_PLACEHOLDERS)[number], string> = {
  "%sourceLanguage%": "Source language name",
  "%targetLanguage%": "Target language name",
  "%projectName%": "Project name",
  "%projectDescription%": "Project description",
  "%projectInstructions%": "Project instructions",
  "%languageInstructions%": "Target language instructions",
  "%fileName%": "Source file path",
  "%fileContext%": "Written or generated file context",
  "%pluralForms%": "Required plural categories and example numbers",
  "%otherLanguages%": "Translations in the selected reference languages",
  "%identicalStrings%": "Proofread translations of matching source text",
  "%glossary%": "Matching glossary terms",
  "%neighbours%": "Nearby strings",
  "%strings%": "The strings and constraints to translate",
  "%customInstruction%": "Instructions for this job",
};
function Llm({ data }: { data: SettingsResult }) {
  const { location } = useRoute();
  const [llm, setLlm] = useState(data.settings.llm);
  const update = <K extends keyof LlmSettings>(key: K, value: LlmSettings[K]) =>
    setLlm({ ...llm, [key]: value });
  return (
    <SaveForm title="LLM translation" save={() => patchSettings({ llm })}>
      {!data.llmAvailable && (
        <p role="status">Translation is off. Enter a Gemini API key above to turn it on.</p>
      )}
      <Fieldset className="settings-field-group">
        <legend>Automatic translation</legend>
        <Check
          label="Reuse current translations of identical source strings before asking the LLM"
          checked={llm.translationMemory ?? false}
          change={(v) => update("translationMemory", v)}
        />
        <Check
          label="Automatically translate on upload"
          checked={llm.autoTranslate}
          change={(v) => update("autoTranslate", v)}
        />
        <Check
          label="When an upload changes the English, rewrite its green translations"
          checked={llm.updateOutdated}
          change={(v) => update("updateOutdated", v)}
        />
        <Check
          label="When an upload changes the English, propose updates for its proofread translations (they stay as they are until a manager accepts)"
          checked={llm.proposeForProofread}
          change={(v) => update("proposeForProofread", v)}
        />
        <p className="field-hint">These apply to uploads only. Auto-translate asks each time.</p>
      </Fieldset>
      <Fieldset className="settings-field-group">
        <legend>Model & budget</legend>
        <Field label="Model" path="llm.model">
          <Input
            list="llm-models"
            value={llm.model}
            required
            onChange={(e) => update("model", e.target.value)}
          />
          <datalist id="llm-models">
            {data.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Requests in parallel" path="llm.concurrency">
          <Input
            type="number"
            min={1}
            max={64}
            required
            value={llm.concurrency}
            onChange={(event) => update("concurrency", Number(event.target.value))}
          />
        </Field>
        <Field label="Monthly token budget (blank for unlimited)" path="llm.monthlyTokenBudget">
          <Input
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            value={llm.monthlyTokenBudget ?? ""}
            onChange={(event) =>
              update(
                "monthlyTokenBudget",
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
          />
        </Field>
      </Fieldset>
      <Field label="Project instructions" path="llm.projectInstructions">
        <TextArea
          autoGrow={false}
          rows={4}
          value={llm.projectInstructions}
          onChange={(e) => update("projectInstructions", e.target.value)}
        />
      </Field>
      <Details className="settings-disclosure">
        <Summary>Customize the prompt</Summary>
        <div className="settings-disclosure-body">
          <Field label="Prompt template" path="llm.promptTemplate">
            <TextArea
              autoGrow={false}
              className="prompt-template"
              rows={16}
              value={llm.promptTemplate}
              onChange={(e) => update("promptTemplate", e.target.value)}
            />
          </Field>
          <ConfirmButton
            variant="secondary"
            title="Reset the prompt?"
            description="This replaces the draft with Quaso’s default prompt. Save to apply it."
            onConfirm={() => {
              update("promptTemplate", data.defaultPromptTemplate);
              return Promise.resolve();
            }}
          >
            Reset to default
          </ConfirmButton>
          <Details>
            <Summary>Prompt placeholders</Summary>
            <dl>
              {PROMPT_PLACEHOLDERS.map((p) => (
                <div key={p}>
                  <dt>
                    <code>{p}</code>
                  </dt>
                  <dd>{PLACEHOLDER_HELP[p]}</dd>
                </div>
              ))}
            </dl>
          </Details>
        </div>
      </Details>
      <Details
        className="settings-disclosure"
        open={location.hash === "#reference-languages" || undefined}
      >
        <Summary>Translation context & reference languages</Summary>
        <div className="settings-disclosure-body">
          <div id="reference-languages">
            <LanguagePicker
              label="Reference languages"
              value={llm.context.otherLanguages}
              onChange={(v) => update("context", { ...llm.context, otherLanguages: v ?? [] })}
            />
          </div>
          {(
            [
              ["identicalStrings", "Include identical proofread strings"],
              ["fileContext", "Include file context"],
              ["glossary", "Include glossary"],
            ] as const
          ).map(([key, label]) => (
            <Check
              key={key}
              label={label}
              checked={llm.context[key]}
              change={(v) => update("context", { ...llm.context, [key]: v })}
            />
          ))}
        </div>
      </Details>
      <Details className="settings-disclosure">
        <Summary>Advanced translation settings</Summary>
        <div className="settings-disclosure-body">
          {(
            [
              ["batchSize", "Strings per batch", 1, 100],
              ["neighbours", "Neighbouring strings", 0, 20],
              ["retries", "Retries", 0, 5],
            ] as const
          ).map(([key, label, min, max]) => (
            <Field key={key} label={label} path={`llm.${key}`}>
              <Input
                type="number"
                min={min}
                max={max}
                required
                value={llm[key]}
                onChange={(e) => update(key, e.target.valueAsNumber)}
              />
            </Field>
          ))}
          <Field label="Safety level" path="llm.safety">
            <Select
              value={llm.safety}
              onChange={(e) => update("safety", e.target.value as LlmSettings["safety"])}
            >
              {["permissive", "default", "strict"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Details>
    </SaveForm>
  );
}

function LanguageRow({
  language,
  refresh,
}: {
  language: LanguageSettings;
  refresh(): Promise<unknown>;
}) {
  const [instructions, setInstructions] = useState(language.instructions);
  const [override, setOverride] = useState(language.pluralOverride);
  const [removeError, setRemoveError] = useState<unknown>();
  return (
    <SaveForm
      title={`${language.name} (${language.tag})`}
      save={async () => {
        await request(`/languages/${encodeURIComponent(language.tag)}`, {
          method: "PATCH",
          body: validated(UpdateLanguageRequest, { instructions, pluralOverride: override }),
        });
        await refresh();
      }}
    >
      <Field label="Language instructions" path="instructions">
        <TextArea
          autoGrow={false}
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Field>
      <p>
        Plural forms: {language.categories.cardinal.join(", ")}. Ordinal forms:{" "}
        {language.categories.ordinal.join(", ")}.
      </p>
      <Check
        label="Override plural categories"
        checked={override !== null}
        change={(v) => setOverride(v ? language.categories : null)}
      />
      {override &&
        (["cardinal", "ordinal"] as const).map((kind) => (
          <Fieldset key={kind}>
            <legend>{kind === "cardinal" ? "Cardinal forms" : "Ordinal forms"}</legend>
            {PLURAL_CATEGORIES.map((c) => (
              <Check
                key={c}
                label={c}
                checked={(override[kind] ?? language.categories[kind]).includes(c)}
                change={(v) =>
                  setOverride({
                    ...override,
                    [kind]: v
                      ? [...(override[kind] ?? language.categories[kind]), c]
                      : (override[kind] ?? language.categories[kind]).filter((x) => x !== c),
                  })
                }
              />
            ))}
          </Fieldset>
        ))}
      <ConfirmButton
        title={`Remove ${language.name}?`}
        description="The language disappears from the project. Its translations and history are kept and return if you add it again."
        onConfirm={async () => {
          try {
            await request(`/languages/${encodeURIComponent(language.tag)}`, { method: "DELETE" });
            await refresh();
            await queryCache.invalidate(["project"]);
          } catch (e) {
            setRemoveError(e);
            throw e;
          }
        }}
      >
        Remove language
      </ConfirmButton>
      {removeError !== undefined && <p role="alert">{errorMessage(removeError)}</p>}
    </SaveForm>
  );
}
function Languages({ data, refresh }: { data: SettingsResult; refresh(): Promise<unknown> }) {
  const [tag, setTag] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  return (
    <>
      <SaveForm
        title="Add a language"
        label="Add language"
        save={async () => {
          const result = await request<{ warnings: string[] }>("/languages", {
            method: "POST",
            body: validated(AddLanguageRequest, { tag }),
          });
          setWarnings(result.warnings);
          setTag("");
          await refresh();
        }}
      >
        <Field label="Language tag" path="tag">
          <Input
            placeholder="pt-BR"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            required
          />
        </Field>
        <p>{tag ? languageName(tag) : "Enter a language tag, such as de, pl or pt-BR."}</p>
        {warnings.map((w) => (
          <p role="status" key={w}>
            {w}
          </p>
        ))}
      </SaveForm>
      {data.languages.map((language) => (
        <LanguageRow key={language.tag} language={language} refresh={refresh} />
      ))}
    </>
  );
}
function FileContext({ file }: { file: SettingsResult["files"][number] }) {
  const [context, setContext] = useState(file.context);
  return (
    <SaveForm
      title={file.path}
      save={() =>
        request(`/files/${file.id}`, {
          method: "PATCH",
          body: validated(UpdateFileRequest, { context }),
        })
      }
    >
      <Field label="File context" path="context">
        <TextArea
          autoGrow={false}
          rows={3}
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
      </Field>
      <p>Generated context: {file.generatedContext || "None yet."}</p>
    </SaveForm>
  );
}
function LimitRow({ string }: { string: StringSummary }) {
  const [limit, setLimit] = useState(string.maxLength?.toString() ?? "");
  return (
    <SaveForm
      title={`${string.file}: ${string.key}`}
      save={() =>
        request(`/strings/${string.id}`, {
          method: "PATCH",
          body: validated(UpdateStringRequest, { maxLength: limit === "" ? null : Number(limit) }),
        })
      }
    >
      <Field label="Maximum characters (empty means no limit)" path="maxLength">
        <Input
          type="number"
          min="0"
          value={limit}
          disabled={string.maxLengthLocked}
          onChange={(e) => setLimit(e.target.value)}
        />
      </Field>
      {string.maxLengthLocked && (
        <p>Locked by the CLI configuration. Update the limit there and upload it.</p>
      )}
    </SaveForm>
  );
}
function Limits({ language }: { language?: string }) {
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const strings = useQuery(
    language ? ["settings-strings", language, search, cursor] : null,
    ({ fresh }) =>
      request<StringsPage>("/strings", {
        query: { language, q: search, cursor, limit: 30 },
        fresh,
      }),
  );
  return (
    <section>
      <H2>Length limits</H2>
      <Label className="field">
        Search strings
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setCursor(undefined);
          }}
        />
      </Label>
      {!language && <p>Add a language to browse the strings.</p>}
      {strings.loading && <Loading />}
      {strings.error !== undefined && <p role="alert">{errorMessage(strings.error)}</p>}
      {strings.data?.strings.length === 0 && <p>No matching strings.</p>}
      {strings.data?.strings.map((s) =>
        s.maxLengthLocked ? (
          <section key={s.id} className="record-card">
            <H3>
              {s.file}: {s.key}
            </H3>
            <p>Maximum {s.maxLength} characters. Locked by the CLI configuration.</p>
          </section>
        ) : (
          <LimitRow key={s.id} string={s} />
        ),
      )}
      {cursor && <Button onClick={() => setCursor(undefined)}>First page</Button>}
      {strings.data?.nextCursor && (
        <Button onClick={() => setCursor(strings.data?.nextCursor ?? undefined)}>Next page</Button>
      )}
    </section>
  );
}
function ApiKeys() {
  const tokens = useQuery(["api-tokens"], ({ fresh }) =>
    request<ApiTokensResult>("/api-tokens", { fresh }),
  );
  const [name, setName] = useState("");
  const [scope, setScope] = useState("read");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  return (
    <>
      <SaveForm
        title="API keys"
        label="Create API key"
        save={async () => {
          const key = await request<CreatedApiToken>("/api-tokens", {
            method: "POST",
            body: validated(CreateApiTokenRequest, { name, scope }),
          });
          setSecret(key.secret);
          setName("");
          await tokens.refresh();
        }}
      >
        <p>
          Use read keys for downloads. Upload keys also change source files and run translation
          jobs. Keep keys in your CI secret store. A key does no more than the person who created it
          may do, so create CI keys with an administrator account. Everyone can create their own
          keys on their account page; this list has everyone's.
        </p>
        <Field label="Key name" path="name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Scope" path="scope">
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="read">Read</option>
            <option value="upload">Upload</option>
          </Select>
        </Field>
      </SaveForm>
      <OneTimeSecret value={secret} title="New API key" onClose={() => setSecret(null)} />
      {tokens.loading && <Loading />}
      {(tokens.error !== undefined || error !== undefined) && (
        <p role="alert">{errorMessage(error ?? tokens.error)}</p>
      )}
      {tokens.data?.tokens.length === 0 && <p>No API keys yet.</p>}
      {tokens.data?.tokens.map((key) => (
        <article className="record-card" key={key.id}>
          <H3>{key.name}</H3>
          <p>
            <code>{key.prefix}</code> · {key.scope} · Created{" "}
            {key.createdBy ? `by ${key.createdBy.name} ` : ""}
            {new Date(key.createdAt).toLocaleString()} · Last used{" "}
            {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}
          </p>
          {key.revokedAt ? (
            <p>Revoked {new Date(key.revokedAt).toLocaleString()}</p>
          ) : (
            <ConfirmButton
              title={`Revoke ${key.name}?`}
              description="Any scripts using this key will lose access immediately."
              onConfirm={async () => {
                try {
                  await request(`/api-tokens/${key.id}`, { method: "DELETE" });
                  await tokens.refresh();
                } catch (e) {
                  setError(e);
                  throw e;
                }
              }}
            >
              Revoke key
            </ConfirmButton>
          )}
        </article>
      ))}
    </>
  );
}

const SECRET_LABELS: Record<ManagedSecretName, string> = {
  gemini_api_key: "Gemini API key",
  email_api_key: "Email API key",
};

function SecretCredential({
  status,
  refresh,
}: {
  status: SecretStatus;
  refresh(): Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [removeError, setRemoveError] = useState<unknown>();
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<{ updatedAt: number | null; error: unknown }>();
  const [testResult, setTestResult] = useState<{
    updatedAt: number | null;
    models: string[];
  } | null>(null);
  const label = SECRET_LABELS[status.name];
  const path = `/settings/secrets/${status.name}`;
  return (
    <>
      <SaveForm
        title={label}
        label={status.set ? "Replace" : "Set key"}
        save={async () => {
          await request(path, { method: "PUT", body: validated(SetSecretRequest, { value }) });
          setValue("");
          await refresh();
        }}
      >
        <p>
          {status.set ? (status.ending ? `Set, ending in …${status.ending}.` : "Set.") : "Not set."}
        </p>
        <Field label={status.set ? `New ${label}` : label} path="value">
          <Input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="new-password"
            required
            maxLength={8192}
          />
        </Field>
      </SaveForm>
      {status.name === "gemini_api_key" && (
        <>
          <Button
            disabled={!status.set || value !== ""}
            busy={testing}
            onClick={async () => {
              setTesting(true);
              setTestError(undefined);
              setTestResult(null);
              try {
                const result = await request<LlmTestResult>("/settings/llm/test", {
                  method: "POST",
                  body: {},
                });
                setTestResult({ updatedAt: result.keyUpdatedAt, models: result.models });
              } catch (error) {
                setTestError({ updatedAt: status.updatedAt, error });
              } finally {
                setTesting(false);
              }
            }}
          >
            Test Gemini key
          </Button>
          {value !== "" && <p>Save the key before testing it.</p>}
          {testError?.updatedAt === status.updatedAt && status.set && (
            <p role="alert">{errorMessage(testError.error)}</p>
          )}
          {testResult && testResult.updatedAt === status.updatedAt && status.set && (
            <div role="status">
              <p>Gemini key works. Available models:</p>
              <ul>
                {testResult.models.map((model) => (
                  <li key={model}>{model}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {status.set && (
        <ConfirmButton
          title={`Remove ${label}?`}
          description="Enter a new key to use this provider again."
          onConfirm={async () => {
            setRemoveError(undefined);
            try {
              await request(path, { method: "DELETE" });
              setValue("");
              await refresh();
            } catch (error) {
              setRemoveError(error);
              throw error;
            }
          }}
        >
          Remove key
        </ConfirmButton>
      )}
      {removeError !== undefined && <p role="alert">{errorMessage(removeError)}</p>}
    </>
  );
}

function EmailConfiguration({
  data,
  credential,
}: {
  data: SettingsResult;
  credential?: SecretStatus;
}) {
  const [email, setEmail] = useState(data.settings.email);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; settings: string; key: number | null }>();
  const [error, setError] = useState<unknown>();
  const saved = JSON.stringify(data.settings.email);
  const unchanged = JSON.stringify(email) === saved;
  const currentResult =
    result?.settings === saved && result?.key === credential?.updatedAt && unchanged;
  async function test() {
    setBusy(true);
    setResult(undefined);
    setError(undefined);
    try {
      const tested = await request<import("@quaso/core").EmailTestResult>("/settings/email/test", {
        method: "POST",
        body: { to },
      });
      setResult({
        message: "Test message accepted. Check the recipient's inbox.",
        settings: saved,
        key: tested.keyUpdatedAt,
      });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SaveForm title="Email delivery" save={() => patchSettings({ email })}>
        <Field label="Email provider" path="email.provider">
          <Select
            value={email.provider}
            onChange={(event) => {
              setEmail({ ...email, provider: event.target.value as typeof email.provider });
              setError(undefined);
            }}
          >
            <option value="none">Off</option>
            <option value="resend">Resend</option>
            <option value="postmark">Postmark</option>
            <option value="cloudflare">Cloudflare</option>
          </Select>
        </Field>
        <Field label="Sender address" path="email.from">
          <Input
            value={email.from}
            onChange={(event) => setEmail({ ...email, from: event.target.value })}
            placeholder="Quaso <quaso@example.com>"
          />
        </Field>
        {email.provider === "cloudflare" && (
          <Field label="Cloudflare account ID" path="email.accountId">
            <Input
              value={email.accountId}
              onChange={(event) => setEmail({ ...email, accountId: event.target.value })}
            />
          </Field>
        )}
      </SaveForm>
      <section className="management-section">
        <H2>Test email</H2>
        <p>
          Save the settings and credential before testing. Your provider must authorize the sender
          domain.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void test();
          }}
        >
          <Field label="Test recipient" path="to">
            <Input
              type="email"
              required
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setResult(undefined);
              }}
            />
          </Field>
          <Button
            type="submit"
            busy={busy}
            disabled={!unchanged || !credential?.set || email.provider === "none"}
          >
            Send test email
          </Button>
          {currentResult && <p role="status">{result.message}</p>}
          {error !== undefined && <p role="alert">{errorMessage(error)}</p>}
        </form>
      </section>
    </>
  );
}

function LanguageRequestSettings({ data }: { data: SettingsResult }) {
  const [enabled, setEnabled] = useState(data.settings.languageRequestsEnabled);
  return (
    <>
      <SaveForm
        title="Language requests"
        save={() => patchSettings({ languageRequestsEnabled: enabled })}
      >
        <Label>
          <Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Let members request and vote for languages
        </Label>
        <p className="muted">
          Turning requests off hides the board and stops new votes. Existing requests are kept.
        </p>
      </SaveForm>
      {data.settings.languageRequestsEnabled && <LanguageRequestsAdmin />}
    </>
  );
}

function Retention({ data }: { data: SettingsResult }) {
  const [fileHistoryDays, setFileHistoryDays] = useState(data.settings.fileHistoryDays);
  const [backupRetentionDays, setBackupRetentionDays] = useState(data.settings.backupRetentionDays);
  return (
    <SaveForm
      title="Retention"
      save={() => patchSettings({ fileHistoryDays, backupRetentionDays })}
    >
      <Field label="File history days" path="fileHistoryDays">
        <Input
          type="number"
          min={0}
          max={36500}
          required
          value={fileHistoryDays}
          onChange={(event) => setFileHistoryDays(Number(event.target.value))}
        />
      </Field>
      <p>
        Keep replaced file versions for this many days. Zero removes replaced versions at the next
        cleanup. Current files are always kept.
      </p>
      <Field label="Backup retention days" path="backupRetentionDays">
        <Input
          type="number"
          min={1}
          max={36500}
          required
          value={backupRetentionDays}
          onChange={(event) => setBackupRetentionDays(Number(event.target.value))}
        />
      </Field>
      <p>
        Changes apply at the next backup or cleanup. Local backups always keep the most recent 48
        hours.
      </p>
    </SaveForm>
  );
}

const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "Project details",
    group: "Project",
    description: "Give your project a name, context and placeholder rules.",
  },
  {
    id: "languages",
    label: "Languages",
    group: "Project",
    description:
      "Choose the languages you support and give translators language-specific guidance.",
  },
  {
    id: "files",
    label: "Files & length limits",
    group: "Project",
    description: "Explain where strings appear and how much space translations can use.",
  },
  {
    id: "requests",
    label: "Language requests",
    group: "Project",
    description: "Let your community help decide which languages to add next.",
  },
  {
    id: "llm",
    label: "AI translation",
    group: "Connections",
    description: "Connect Gemini, guide the translator and control automatic translation.",
  },
  {
    id: "email",
    label: "Email delivery",
    group: "Connections",
    description: "Connect email for account verification, sign-in links and password resets.",
  },
  {
    id: "keys",
    label: "API keys",
    group: "Connections",
    description: "Give your CLI and continuous integration access to the project.",
  },
  {
    id: "backups",
    label: "Backups",
    group: "Data",
    description: "Download a copy of the project and check your automatic backups.",
  },
  {
    id: "retention",
    label: "History & retention",
    group: "Data",
    description: "Choose how long to keep replaced files and project backups.",
  },
] as const;

function SettingsContent() {
  useDocumentTitle("Settings");
  const { query: routeQuery, setQuery } = useRoute();
  const query = useQuery(["settings"], ({ fresh }) =>
    request<SettingsResult>("/settings", { fresh }),
  );
  const secrets = useQuery(["settings-secrets"], ({ fresh }) =>
    request<SecretsResult>("/settings/secrets", { fresh }),
  );
  const current =
    SETTINGS_SECTIONS.find((entry) => entry.id === routeQuery.section) ?? SETTINGS_SECTIONS[0];
  const section = current.id;
  return (
    <div className="page management-page settings-page">
      <div className="page-head workspace-heading">
        <div>
          <H1 ui>Settings</H1>
          <p className="muted">Make Quaso work the way your team translates.</p>
        </div>
      </div>
      {secrets.data && secrets.data.missingSecrets.length > 0 && (
        <p role="alert">
          This backup omitted credentials. Enter them again:{" "}
          {secrets.data.missingSecrets.map((name) => SECRET_LABELS[name]).join(", ")}.
        </p>
      )}
      {secrets.error !== undefined && (
        <p role="alert">
          {errorMessage(secrets.error)}{" "}
          <Button onClick={() => void secrets.refresh().catch(() => {})}>
            Retry loading credentials
          </Button>
        </p>
      )}
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {["Project", "Connections", "Data"].map((group) => (
            <div className="settings-navigation-group" key={group}>
              <p>{group}</p>
              {SETTINGS_SECTIONS.filter((entry) => entry.group === group).map((entry) => (
                <Link
                  key={entry.id}
                  to={href("/settings", { ...routeQuery, section: entry.id })}
                  quiet
                  aria-current={section === entry.id ? "page" : undefined}
                >
                  {entry.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-content">
          <Label className="field settings-mobile-section">
            Section
            <Select
              value={section}
              onChange={(e) => setQuery({ section: e.target.value }, { replace: false })}
            >
              {SETTINGS_SECTIONS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Label>
          <div className="settings-section-intro">
            <H2 ui>{current.label}</H2>
            <p className="muted">{current.description}</p>
          </div>
          {query.loading && <Loading label="Loading settings…" />}
          {query.error !== undefined && (
            <p role="alert">
              {errorMessage(query.error)}{" "}
              <Button onClick={() => void query.refresh().catch(() => {})}>Try again</Button>
            </p>
          )}
          {query.data && (
            <>
              {section === "general" && <General data={query.data} />}
              {section === "retention" && <Retention data={query.data} />}
              {section === "requests" && <LanguageRequestSettings data={query.data} />}
              {section === "languages" && (
                <>
                  <Languages data={query.data} refresh={query.refresh} />
                </>
              )}
              {section === "llm" && (
                <>
                  {secrets.data?.secrets
                    .filter((secret) => secret.name === "gemini_api_key")
                    .map((secret) => (
                      <SecretCredential
                        key={secret.name}
                        status={secret}
                        refresh={secrets.refresh}
                      />
                    ))}
                  <Llm data={query.data} />
                </>
              )}
              {section === "email" && (
                <>
                  {secrets.data?.secrets
                    .filter((secret) => secret.name === "email_api_key")
                    .map((secret) => (
                      <SecretCredential
                        key={secret.name}
                        status={secret}
                        refresh={secrets.refresh}
                      />
                    ))}
                  <EmailConfiguration
                    data={query.data}
                    credential={secrets.data?.secrets.find(
                      (secret) => secret.name === "email_api_key",
                    )}
                  />
                </>
              )}
              {section === "files" && (
                <>
                  {query.data.files.length === 0 && (
                    <p>Upload your source files to add file context and length limits.</p>
                  )}
                  {query.data.files.map((f) => (
                    <FileContext key={f.id} file={f} />
                  ))}
                  <Limits language={query.data.languages[0]?.tag} />
                </>
              )}
              {section === "keys" && <ApiKeys />}
              {section === "backups" && (
                <section className="management-section">
                  <H2>Backups</H2>
                  <p>
                    Backups include user records and API key hashes. Keep them in private storage.
                  </p>
                  <p>
                    <A href={apiUrl("/backup", { format: "sqlite" })} download>
                      Download SQLite backup
                    </A>
                  </p>
                  <p>
                    <A href={apiUrl("/backup", { format: "json" })} download>
                      Download JSON backup
                    </A>
                  </p>
                  <AdminDetails backupsOnly />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
export function SettingsPage() {
  return (
    <Access action="settings">
      <SettingsContent />
    </Access>
  );
}
