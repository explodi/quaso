// SPDX-License-Identifier: MIT
import { Fieldset, Label, Checkbox, Button, Dialog, Field, Loading } from "@quaso/design-system";
/** Managers choose a scope, get a live dry-run estimate, and follow the created job. */
import { languageName, type JobScope } from "@quaso/core";
import { useMemo, useState } from "react";
import { createJob, listSources, request } from "../lib/api.ts";
import { useMutation, useQuery } from "../lib/data.ts";
import { fieldError } from "../lib/forms.ts";
import { useDebounced, useProject } from "../lib/hooks.ts";
import { checkJobRequest } from "../lib/management-api.ts";
import { useSession } from "../lib/session.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { LanguagePicker, SelectField, TextField } from "./Management.tsx";
import { FileTree } from "./FileTree.tsx";
import { buildTree, type TreeNode } from "../lib/tree.ts";
import { Link } from "../lib/router.tsx";
import { count as formatCount } from "../lib/format.ts";
import { outdatedExplanation } from "../lib/states.ts";

export function AutoTranslateButton({ language, file }: { language?: string; file?: string }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  if (!session.can("translate")) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>Auto-translate</Button>
      {open && (
        <AutoTranslateDialog language={language} file={file} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function AutoTranslateDialog({
  language,
  file,
  onClose,
  strings,
}: {
  language?: string;
  file?: string;
  onClose(): void;
  strings?: number[];
}) {
  const project = useProject();
  const [languages, setLanguages] = useState<string[] | null>(language ? [language] : null);
  const [files, setFiles] = useState<string[] | null>(file ? [file] : null);
  const [retranslate, setRetranslate] = useState(false);
  const [outdated, setOutdated] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState("");
  const fileQuery = useQuery(["sources"], () => listSources({ fresh: true }), { staleTime: 0 });
  const tree = useMemo(() => buildTree(fileQuery.data?.files ?? []), [fileQuery.data]);
  const selectedFiles = (fileQuery.data?.files ?? [])
    .filter(
      (source) =>
        files === null ||
        files.some((path) =>
          path.endsWith("/") ? source.path.startsWith(path) : source.path === path,
        ),
    )
    .map((source) => source.path);
  const root: TreeNode = {
    type: "folder",
    name: "All files",
    path: "",
    depth: -1,
    children: tree,
    progress: { strings: 0, words: 0 },
  };
  const models = useQuery(project.data?.llmAvailable ? ["models"] : null, (options) =>
    request<{ models: string[] }>("/models", options),
  );
  const scope: JobScope = {
    languages: languages ?? undefined,
    files: files === null ? undefined : selectedFiles,
    strings,
    retranslate,
    outdated,
    instruction: instruction || undefined,
    model: model || undefined,
  };
  const scopeJson = JSON.stringify(scope);
  const debouncedScope = useDebounced(scopeJson, 300);
  const validScope = (languages === null || languages.length > 0) && selectedFiles.length > 0;
  const estimate = useQuery(
    project.data?.llmAvailable && validScope ? ["estimate", debouncedScope] : null,
    () => createJob(checkJobRequest({ ...JSON.parse(debouncedScope), dryRun: true })),
    { staleTime: 0 },
  );
  const start = useMutation((body: JobScope) => createJob(checkJobRequest(body)), {
    invalidate: [["jobs"]],
    onSuccess: (result) => {
      if (result.job) onClose();
    },
  });
  const count = estimate.data?.estimate;
  const words = new Map(count?.files.map((entry) => [entry.file, entry.words]) ?? []);
  const references = project.data?.referenceLanguages ?? [];
  return (
    <Dialog open title="Auto-translate" onClose={onClose} size="large">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          start.run(scope).catch(() => {});
        }}
      >
        <p>
          The LLM writes green translations, which players get at once. It never changes a proofread
          (blue) translation: it proposes an update for review instead.
        </p>
        {project.data && !project.data.llmAvailable && (
          <p className="notice notice-warning">
            LLM translation is unavailable: this server has no LLM provider or API key.
          </p>
        )}
        <LanguagePicker
          value={languages}
          onChange={setLanguages}
          allowAll
          error={fieldError(start.error, "languages")}
        />
        {project.data && (
          <p className="reference-languages">
            {references.length > 0
              ? `The LLM also sees: ${references.map((tag) => languageName(tag)).join(", ")} (proofread strings marked).`
              : "No reference languages."}{" "}
            <Link to="/settings?section=llm#reference-languages">Reference language settings</Link>
          </p>
        )}
        <Fieldset>
          <legend>Files</legend>
          {fileQuery.loading && <Loading label="Loading files…" />}
          {fileQuery.error !== undefined && <ErrorMessage error={fileQuery.error} />}
          {fileQuery.data && (
            <FileTree
              nodes={[root]}
              label="Files to translate"
              onOpen={() => {}}
              selection={{ files: selectedFiles, onChange: setFiles, words }}
            />
          )}
        </Fieldset>
        {strings && <p>{strings.length} selected strings</p>}
        <SelectField
          label="Which strings"
          value={retranslate ? "green" : "untranslated"}
          onChange={(value) => setRetranslate(value === "green")}
        >
          <option value="untranslated">Untranslated only</option>
          <option value="green">Also re-translate green translations</option>
        </SelectField>
        <div>
          <Label className="check-label">
            <Checkbox
              checked={outdated}
              onChange={(e) => setOutdated(e.target.checked)}
              aria-describedby="auto-translate-outdated-hint"
            />
            Update outdated translations
          </Label>
          <p id="auto-translate-outdated-hint" className="field-hint">
            {outdatedExplanation(project.data?.sourceLanguageName ?? "source text", 2)} Green ones
            are rewritten for the new {project.data?.sourceLanguageName ?? "source text"}; proofread
            ones get a proposal, and stay as they are until a manager accepts it.
          </p>
        </div>
        <TextField
          label="Custom instruction (optional)"
          value={instruction}
          onChange={setInstruction}
          maxLength={4000}
          error={fieldError(start.error, "instruction")}
        />
        <Field
          label="Model (optional)"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          list="job-models"
          maxLength={200}
          hint="Leave empty to use the project’s default model."
          error={fieldError(start.error, "model")}
        />
        <datalist id="job-models">
          {models.data?.models.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <div aria-live="polite" className="estimate">
          {!validScope ? (
            <p>Choose at least one language and one file.</p>
          ) : estimate.loading || scopeJson !== debouncedScope ? (
            <Loading label="Estimating translation work…" />
          ) : (
            count && (
              <p>
                <strong>
                  {count.strings} strings · {count.words} words · {count.requests} requests
                </strong>
                <br />
                Estimated tokens: {count.estimatedTokens.input} input +{" "}
                {count.estimatedTokens.output} output
                <span className="estimate-work">
                  {count.work.translate > 0 && (
                    <span>
                      {formatCount(count.work.translate, "untranslated string")}: translated
                    </span>
                  )}
                  {count.work.retranslate > 0 && (
                    <span>
                      {formatCount(count.work.retranslate, "green translation")}: translated again
                    </span>
                  )}
                  {count.work.update > 0 && (
                    <span>
                      {formatCount(count.work.update, "outdated green translation")}: rewritten
                    </span>
                  )}
                  {count.work.propose > 0 && (
                    <span>
                      {formatCount(count.work.propose, "outdated proofread translation")}: a
                      proposal each, for review; the translations stay as they are
                    </span>
                  )}
                </span>
                <span className="estimate-languages">
                  {count.languages.map((entry) => (
                    <span key={entry.language}>
                      {languageName(entry.language)}: {formatCount(entry.strings, "string")} ·{" "}
                      {formatCount(entry.words, "word")}
                    </span>
                  ))}
                </span>
              </p>
            )
          )}
        </div>
        {estimate.error !== undefined && <ErrorMessage error={estimate.error} />}
        {start.error !== undefined && <ErrorMessage error={start.error} />}
        <Button
          type="submit"
          variant="primary"
          busy={start.pending}
          disabled={
            !project.data?.llmAvailable ||
            !validScope ||
            !count ||
            !!estimate.error ||
            scopeJson !== debouncedScope ||
            estimate.fetching
          }
        >
          Start translation
        </Button>
      </form>
    </Dialog>
  );
}
