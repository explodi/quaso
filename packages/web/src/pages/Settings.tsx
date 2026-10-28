// SPDX-License-Identifier: MIT
import {
  A,
  Button,
  Details,
  Fieldset,
  H1,
  H2,
  H3,
  Input,
  Label,
  Loading,
  Select,
  Summary,
  Switch,
  TextArea,
} from "@quaso/design-system";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";
import {
  AddLanguageRequest,
  type ApiTokensResult,
  CreateApiTokenRequest,
  type CreatedApiToken,
  languageName,
  type LanguageSettings,
  type LlmSettings,
  type LlmTestResult,
  type ManagedSecretName,
  PLURAL_CATEGORIES,
  PROMPT_PLACEHOLDERS,
  type SecretsResult,
  type SecretStatus,
  SetSecretRequest,
  type SettingsResult,
  type StringsPage,
  type StringSummary,
  UpdateFileRequest,
  UpdateFolderRequest,
  UpdateLanguageRequest,
  UpdateSettingsRequest,
  UpdateStringRequest,
} from "@quaso/core";
import { Access, ConfirmButton, LanguagePicker, OneTimeSecret } from "../components/Management.tsx";
import { ModelSelect } from "../components/ModelSelect.tsx";
import { apiUrl, errorMessage, request } from "../lib/api.ts";
import { queryCache, useQuery } from "../lib/data.ts";
import { fieldError, validated } from "../lib/forms.ts";
import { SETTINGS_SECTIONS, SettingsNavigation } from "../components/SettingsNavigation.tsx";
import { useRoute } from "../lib/router.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { AdminDetails } from "./Admin.tsx";
import { LanguageRequestsAdmin } from "../components/LanguageRequests.tsx";

const FormError = createContext<unknown>(undefined);

/** A validation error must stay reachable even when its advanced section is collapsed. */
function revealSetting(element: Element) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
}
function SaveForm({
  title,
  children,
  save,
  label = "Save changes",
  description,
}: {
  title: string;
  children: ReactNode;
  save(): Promise<unknown>;
  label?: string;
  description?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  return (
    <section className="management-section settings-card">
      <header className="settings-card-header">
        <H2 ui>{title}</H2>
        {description && <p>{description}</p>}
      </header>
      <form
        className="settings-form"
        onChange={() => setSaved(false)}
        onInvalidCapture={(event) => revealSetting(event.target as HTMLElement)}
        onClickCapture={(event) => {
          // Collection actions and prompt resets also change a draft without a change event.
          if ((event.target as HTMLElement).closest('button:not([type="submit"])')) setSaved(false);
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const form = event.currentTarget;
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
            for (const field of form.querySelectorAll<HTMLElement>("[data-settings-path]")) {
              if (fieldError(caught, field.dataset.settingsPath!)) revealSetting(field);
            }
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
          <p role="alert" className="field-error settings-form-error">
            {errorMessage(error)}
          </p>
        )}
        <footer className="settings-actions">
          <Button type="submit" variant="primary" busy={busy}>
            {label}
          </Button>
          {saved ? (
            <p role="status">Saved.</p>
          ) : (
            <p className="muted">Changes apply when you save.</p>
          )}
        </footer>
      </form>
    </section>
  );
}
function Field({
  label,
  path,
  hint,
  children,
}: {
  label: string;
  path: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const error = fieldError(useContext(FormError), path);
  const id = useId();
  return (
    <Label className="field settings-row" data-settings-path={path}>
      <span className="settings-label">
        <span id={id} className="field-label">
          {label}
        </span>
        {hint && (
          <span id={`${id}-hint`} className="field-hint">
            {hint}
          </span>
        )}
      </span>
      <span className="settings-control">
        {Children.map(children, (child) =>
          isValidElement(child) &&
          [Input, Select, TextArea, ModelSelect].includes(child.type as typeof Input)
            ? cloneElement(child as ReactElement<Record<string, unknown>>, {
                "aria-labelledby": id,
                "aria-describedby":
                  [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
                  undefined,
                "aria-invalid": error ? true : undefined,
              })
            : child,
        )}
        {error && (
          <span id={`${id}-error`} className="field-error">
            {error}
          </span>
        )}
      </span>
    </Label>
  );
}
function Check({
  label,
  hint,
  checked,
  change,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  change(value: boolean): void;
}) {
  const id = useId();
  return (
    <Label className="settings-row settings-check">
      <span className="settings-label">
        <span id={id} className="field-label">
          {label}
        </span>
        {hint && (
          <span id={`${id}-hint`} className="field-hint">
            {hint}
          </span>
        )}
      </span>
      <Switch
        aria-labelledby={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        checked={checked}
        onChange={(e) => change(e.target.checked)}
      />
    </Label>
  );
}
function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-group">
      <header className="settings-group-header">
        <H3 ui>{title}</H3>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}
function patchSettings(body: unknown) {
  return request("/settings", {
    method: "PATCH",
    body: validated(UpdateSettingsRequest, body),
  });
}

function General({ data }: { data: SettingsResult }) {
  const [name, setName] = useState(data.settings.name);
  const [description, setDescription] = useState(data.settings.description);
  const [logoUrl, setLogoUrl] = useState(data.settings.logoUrl ?? "");
  const [links, setLinks] = useState(data.settings.links);
  return (
    <>
      <SaveForm
        title="Project details"
        label="Save project"
        description="Introduce your project to the people translating it."
        save={() => patchSettings({ name, description, logoUrl: logoUrl || null })}
      >
        <Field
          label="Project name"
          path="name"
          hint="Shown in the header and on the project dashboard."
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field
          label="Description"
          path="description"
          hint="A short introduction to your game or app."
        >
          <TextArea
            autoGrow={false}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </Field>
        <Field
          label="Logo URL"
          path="logoUrl"
          hint="A link to your project’s logo. Leave blank to use the default."
        >
          <Input
            type="url"
            value={logoUrl}
            placeholder="https://example.com/logo.png"
            onChange={(e) => setLogoUrl(e.target.value)}
          />
        </Field>
      </SaveForm>
      <SaveForm
        title="Project links"
        label="Save links"
        description="Links to your website, store page, or community. These appear in the footer."
        save={() => patchSettings({ links })}
      >
        {links.length === 0 && (
          <p className="settings-note">
            No project links yet. Add a destination for your community.
          </p>
        )}
        {links.map((link, i) => (
          <div className="settings-repeat-row" key={i}>
            <Field label="Label" path={`links.${i}.label`}>
              <Input
                value={link.label}
                placeholder="Website"
                required
                onChange={(e) =>
                  setLinks(
                    links.map((item, j) => (i === j ? { ...item, label: e.target.value } : item)),
                  )
                }
              />
            </Field>
            <Field label="URL" path={`links.${i}.url`}>
              <Input
                type="url"
                value={link.url}
                placeholder="https://example.com"
                required
                onChange={(e) =>
                  setLinks(
                    links.map((item, j) => (i === j ? { ...item, url: e.target.value } : item)),
                  )
                }
              />
            </Field>
            <Button
              variant="ghost"
              aria-label={`Remove link ${i + 1}`}
              onClick={() => setLinks(links.filter((_, j) => i !== j))}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="settings-add">
          <Button
            disabled={links.length >= 20}
            onClick={() => setLinks([...links, { label: "", url: "" }])}
          >
            Add link
          </Button>
        </div>
      </SaveForm>
    </>
  );
}

function Placeholders({ data }: { data: SettingsResult }) {
  const [syntax, setSyntax] = useState(data.settings.syntax);
  // Keep the user's text intact while typing; normalize language codes only when saving.
  const [optional, setOptional] = useState(
    (data.settings.syntax.optional ?? []).map((entry) => ({
      ...entry,
      languages: entry.languages.join(", "),
    })),
  );
  const extra = syntax.extra ?? [];
  return (
    <SaveForm
      title="Placeholder rules"
      label="Save placeholder rules"
      description="Placeholders are values your app inserts into a translation, such as a player’s name."
      save={() =>
        patchSettings({
          syntax: {
            ...syntax,
            optional: optional.map((entry) => ({
              ...entry,
              languages: entry.languages
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            })),
          },
        })
      }
    >
      <SettingsGroup
        title="Message format"
        description="How your app fills in placeholders and chooses between texts."
      >
        <Check
          label="ICU MessageFormat"
          hint={
            <>
              As with i18next-icu: placeholders such as <code>{"{name}"}</code>, and blocks such as{" "}
              <code>{"{count, plural, one {# item} other {# items}}"}</code>, in JSON strings and
              Markdown documents. Instead of <code>{"{{name}}"}</code> and <code>$t(…)</code>.
            </>
          }
          checked={syntax.icu === true}
          change={(icu) => setSyntax({ ...syntax, icu })}
        />
      </SettingsGroup>
      <SettingsGroup
        title="Default format"
        description="Match the opening and closing characters used by your app."
      >
        <div className="settings-inline-fields">
          <Field label="Opening characters" path="syntax.prefix">
            <Input
              value={syntax.prefix}
              required
              maxLength={10}
              onChange={(e) => setSyntax({ ...syntax, prefix: e.target.value })}
            />
          </Field>
          <Field label="Closing characters" path="syntax.suffix">
            <Input
              value={syntax.suffix}
              required
              maxLength={10}
              onChange={(e) => setSyntax({ ...syntax, suffix: e.target.value })}
            />
          </Field>
        </div>
        <p className="settings-preview">
          Example{" "}
          <code>
            {syntax.prefix}player_name{syntax.suffix}
          </code>
          <span className="muted">→ the player’s name in your app</span>
        </p>
      </SettingsGroup>
      <SettingsGroup
        title="Additional formats"
        description={
          <>
            Recognize other placeholder formats too, such as <code>{"{name}"}</code> alongside{" "}
            <code>{"{{name}}"}</code>.
          </>
        }
      >
        {extra.length === 0 && (
          <p className="settings-note">Only the default format is recognized.</p>
        )}
        {extra.map((delimiters, i) => (
          <div className="settings-repeat-row" key={i}>
            <Field label="Opening characters" path={`syntax.extra.${i}.prefix`}>
              <Input
                value={delimiters.prefix}
                required
                maxLength={10}
                onChange={(e) =>
                  setSyntax({
                    ...syntax,
                    extra: extra.map((item, j) =>
                      i === j ? { ...item, prefix: e.target.value } : item,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Closing characters" path={`syntax.extra.${i}.suffix`}>
              <Input
                value={delimiters.suffix}
                required
                maxLength={10}
                onChange={(e) =>
                  setSyntax({
                    ...syntax,
                    extra: extra.map((item, j) =>
                      i === j ? { ...item, suffix: e.target.value } : item,
                    ),
                  })
                }
              />
            </Field>
            <Button
              variant="ghost"
              aria-label={`Remove format ${i + 1}`}
              onClick={() =>
                setSyntax({
                  ...syntax,
                  extra: extra.filter((_, j) => i !== j),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="settings-add">
          <Button
            disabled={extra.length >= 10}
            onClick={() =>
              setSyntax({
                ...syntax,
                extra: [...extra, { prefix: "", suffix: "" }],
              })
            }
          >
            Add format
          </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup
        title="Language exceptions"
        description={
          <>
            Allow a specific placeholder to be left out in selected languages. For example, a
            language without articles may not need <code>{"{article}"}</code>.
          </>
        }
      >
        {optional.length === 0 && (
          <p className="settings-note">All placeholders are required in every language.</p>
        )}
        {optional.map((entry, i) => (
          <div className="settings-repeat-row" key={i}>
            <Field
              label="Placeholder"
              path={`syntax.optional.${i}.placeholder`}
              hint="Include its opening and closing characters."
            >
              <Input
                value={entry.placeholder}
                placeholder="{article}"
                required
                maxLength={100}
                onChange={(e) =>
                  setOptional(
                    optional.map((item, j) =>
                      i === j ? { ...item, placeholder: e.target.value } : item,
                    ),
                  )
                }
              />
            </Field>
            <Field
              label="Languages"
              path={`syntax.optional.${i}.languages`}
              hint="Language codes, separated by commas."
            >
              <Input
                value={entry.languages}
                placeholder="pl, tr, ja"
                required
                onChange={(e) =>
                  setOptional(
                    optional.map((item, j) =>
                      i === j ? { ...item, languages: e.target.value } : item,
                    ),
                  )
                }
              />
            </Field>
            <Button
              variant="ghost"
              aria-label={`Remove language exception ${i + 1}`}
              onClick={() => setOptional(optional.filter((_, j) => i !== j))}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="settings-add">
          <Button
            disabled={optional.length >= 50}
            onClick={() => setOptional([...optional, { placeholder: "", languages: "" }])}
          >
            Add language exception
          </Button>
        </div>
      </SettingsGroup>
      <p className="settings-note">
        Saving these rules rechecks existing translations for missing or changed placeholders.
      </p>
    </SaveForm>
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
  "%fileContext%": "Folder contexts, then the written or generated file context",
  "%pluralForms%": "Required plural categories and example numbers",
  "%otherLanguages%": "Translations in the selected reference languages",
  "%identicalStrings%": "Proofread translations of matching source text",
  "%glossary%": "Matching glossary terms",
  "%neighbours%": "Nearby strings",
  "%strings%": "The strings and constraints to translate",
  "%customInstruction%": "Instructions for this job",
};
function Llm({ data }: { data: SettingsResult }) {
  const [llm, setLlm] = useState(data.settings.llm);
  const meaning = llm.meaningCheck ?? {
    enabled: false,
    colours: "blue" as const,
    onSave: true,
    onApproval: true,
    model: "",
    countsAgainstBudget: true,
  };
  const updateMeaning = (patch: Partial<typeof meaning>) =>
    setLlm({ ...llm, meaningCheck: { ...meaning, ...patch } });
  const update = <K extends keyof LlmSettings>(key: K, value: LlmSettings[K]) =>
    setLlm({ ...llm, [key]: value });
  return (
    <SaveForm
      title="AI translation"
      label="Save AI settings"
      description="Choose when translations run and give the model guidance for your project."
      save={() => patchSettings({ llm })}
    >
      {!data.llmAvailable && (
        <p role="status">Translation is off. Enter a Gemini API key above to turn it on.</p>
      )}
      <SettingsGroup
        title="Automatic translation"
        description="These settings apply to uploads. Auto-translate asks each time."
      >
        <Check
          label="Reuse translations of identical source strings"
          hint="Use current translations of matching source text before asking the model."
          checked={llm.translationMemory ?? false}
          change={(value) => update("translationMemory", value)}
        />
        <Check
          label="Automatically translate on upload"
          hint="Translate new source strings as soon as you upload them."
          checked={llm.autoTranslate}
          change={(value) => update("autoTranslate", value)}
        />
        <Check
          label="Update outdated translations"
          hint="Refresh translations when an upload changes their source text, proofread ones too: proofreading holds only for the text it was made for, and comes back if that text does."
          checked={llm.updateOutdated}
          change={(value) => update("updateOutdated", value)}
        />
      </SettingsGroup>
      <SettingsGroup
        title="Meaning checks"
        description="Compare a translation with its source and flag differences as warnings. You can also run checks for a language, file, or string."
      >
        <Check
          label="Automatically compare translation meaning"
          checked={meaning.enabled}
          change={(enabled) => updateMeaning({ enabled })}
        />
        <Field label="Which translations" path="llm.meaningCheck.colours">
          <Select
            value={meaning.colours}
            onChange={(event) => updateMeaning({ colours: event.target.value as "blue" | "all" })}
          >
            <option value="blue">Proofread translations only</option>
            <option value="all">Every colour</option>
          </Select>
        </Field>
        <Check
          label="Check on save"
          checked={meaning.onSave}
          change={(onSave) => updateMeaning({ onSave })}
        />
        <Check
          label="Check on approval"
          checked={meaning.onApproval}
          change={(onApproval) => updateMeaning({ onApproval })}
        />
        <Check
          label="Count checks against the monthly token budget"
          checked={meaning.countsAgainstBudget}
          change={(countsAgainstBudget) => updateMeaning({ countsAgainstBudget })}
        />
        <Field
          label="Meaning-check model"
          path="llm.meaningCheck.model"
          hint="Choose another model, or follow the project model."
        >
          <ModelSelect
            models={data.models}
            value={meaning.model}
            blankLabel={`The project model (${llm.model})`}
            onChange={(model) => updateMeaning({ model })}
          />
        </Field>
      </SettingsGroup>
      <SettingsGroup title="Model & budget">
        <Field label="Model" path="llm.model">
          <ModelSelect
            models={data.models}
            value={llm.model}
            required
            onChange={(model) => update("model", model)}
          />
        </Field>
        <Field
          label="Model for editor suggestions"
          path="llm.suggestionModel"
          hint="Suggestions appear while translators type, so a faster model helps. Jobs, uploads and Auto-translate use the model above."
        >
          <ModelSelect
            models={data.models}
            value={llm.suggestionModel}
            blankLabel={`The project model (${llm.model})`}
            onChange={(model) => update("suggestionModel", model)}
          />
        </Field>
        <Field
          label="Requests in parallel"
          path="llm.concurrency"
          hint="How many translation requests can run at the same time."
        >
          <Input
            type="number"
            min={1}
            max={64}
            required
            value={llm.concurrency}
            onChange={(event) => update("concurrency", Number(event.target.value))}
          />
        </Field>
        <Field
          label="Monthly token budget"
          path="llm.monthlyTokenBudget"
          hint="Stop new translation jobs when the budget is reached. Leave blank for no limit."
        >
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
      </SettingsGroup>
      <Field
        label="Project instructions"
        path="llm.projectInstructions"
        hint="Describe tone, terminology, and any rules every language should follow."
      >
        <TextArea
          autoGrow={false}
          rows={4}
          value={llm.projectInstructions}
          onChange={(e) => update("projectInstructions", e.target.value)}
        />
      </Field>
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
      <Details className="settings-advanced">
        <Summary>Advanced: prompt and performance</Summary>
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
          body: validated(UpdateLanguageRequest, {
            instructions,
            pluralOverride: override,
          }),
        });
        await refresh();
      }}
    >
      <Field
        label="Language instructions"
        path="instructions"
        hint="Guidance for this language, in addition to the project instructions."
      >
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
            await request(`/languages/${encodeURIComponent(language.tag)}`, {
              method: "DELETE",
            });
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
      <Field
        label="File context"
        path="context"
        hint="Explain where these strings appear so the model can translate them in context."
      >
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
function FolderContext({ folder }: { folder: SettingsResult["folders"][number] }) {
  const [context, setContext] = useState(folder.context);
  return (
    <SaveForm
      title={`${folder.path}/`}
      save={() =>
        request("/folders", {
          method: "PATCH",
          body: validated(UpdateFolderRequest, { path: folder.path, context }),
        })
      }
    >
      <Field
        label="Folder context"
        path="context"
        hint="The model reads this with every file in this folder and its subfolders, before the file's own context."
      >
        <TextArea
          autoGrow={false}
          rows={3}
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
      </Field>
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
          body: validated(UpdateStringRequest, {
            maxLength: limit === "" ? null : Number(limit),
          }),
        })
      }
    >
      <Field label="Maximum characters" path="maxLength" hint="Leave blank for no limit.">
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
        <Field label="Permissions" path="scope" hint="Choose what this key is allowed to do.">
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="read">Download translations</option>
            <option value="upload">Download, upload & translate</option>
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
                  await request(`/api-tokens/${key.id}`, {
                    method: "DELETE",
                  });
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
          await request(path, {
            method: "PUT",
            body: validated(SetSecretRequest, { value }),
          });
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
                setTestResult({
                  updatedAt: result.keyUpdatedAt,
                  models: result.models,
                });
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
              setEmail({
                ...email,
                provider: event.target.value as typeof email.provider,
              });
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
        <Check
          label="Let members request and vote for languages"
          checked={enabled}
          change={setEnabled}
          hint="Turning this off hides the request board and stops new votes. Existing requests are kept."
        />
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
      title="History & retention"
      description="Choose how long to keep older files and local backups."
      save={() => patchSettings({ fileHistoryDays, backupRetentionDays })}
    >
      <Field
        label="File history days"
        path="fileHistoryDays"
        hint="How long to keep replaced file versions. Set to 0 to remove them at the next cleanup. Current files are always kept."
      >
        <Input
          type="number"
          min={0}
          max={36500}
          required
          value={fileHistoryDays}
          onChange={(event) => setFileHistoryDays(Number(event.target.value))}
        />
      </Field>
      <Field
        label="Backup retention days"
        path="backupRetentionDays"
        hint="Applies at the next backup or cleanup. Local backups always keep the most recent 48 hours."
      >
        <Input
          type="number"
          min={1}
          max={36500}
          required
          value={backupRetentionDays}
          onChange={(event) => setBackupRetentionDays(Number(event.target.value))}
        />
      </Field>
    </SaveForm>
  );
}

function SettingsContent() {
  const { query: routeQuery } = useRoute();
  const query = useQuery(["settings"], ({ fresh }) =>
    request<SettingsResult>("/settings", { fresh }),
  );
  const secrets = useQuery(["settings-secrets"], ({ fresh }) =>
    request<SecretsResult>("/settings/secrets", { fresh }),
  );
  const currentSection =
    SETTINGS_SECTIONS.find((item) => item.id === routeQuery.section) ?? SETTINGS_SECTIONS[0];
  const section = currentSection.id;
  useDocumentTitle(`${currentSection.label} · Settings`);
  return (
    <div className="page management-page settings-page">
      <div className="settings-layout">
        <SettingsNavigation section={section} />
        <div className="settings-content" key={section}>
          <header className="settings-page-heading">
            <p className="settings-eyebrow">Settings / {currentSection.group}</p>
            <H1 ui>{currentSection.label}</H1>
            <p className="muted">{currentSection.description}</p>
          </header>
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
              {section === "placeholders" && <Placeholders data={query.data} />}
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
                  {query.data.folders.map((folder) => (
                    <FolderContext key={folder.path} folder={folder} />
                  ))}
                  {query.data.files.map((f) => (
                    <FileContext key={f.id} file={f} />
                  ))}
                  <Limits language={query.data.languages[0]?.tag} />
                </>
              )}
              {section === "keys" && <ApiKeys />}
              {section === "backups" && (
                <>
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
                  </section>
                  <AdminDetails backupsOnly />
                </>
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
