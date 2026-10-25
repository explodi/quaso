// SPDX-License-Identifier: MIT
import { QualityCheckButton, QualityJobProgress } from "../../components/QualityChecks.tsx";
import {
  Label,
  H2,
  H3,
  Kbd,
  Button,
  Chip,
  Dialog,
  Notice,
  CheckSquareIcon,
  CopyIcon,
  InfoIcon,
  SparklesIcon,
  TrashIcon,
  UndoIcon,
  UserIcon,
  WarningIcon,
  Loading,
  SpinnerIcon,
  Switch,
  Tabs,
  TextArea,
} from "@quaso/design-system";

/** A source-to-translation workspace with local drafts, quality checks, and revision conflicts. */
import {
  type CheckResult,
  checkTranslation,
  graphemeLength,
  type IcuField,
  icuWithLanguageCases,
  type InterpolationSyntax,
  type LanguageProgress,
  paragraphCount,
  type ProjectInfo,
  type StringArgument,
  type StringDetail,
  type StringSummary,
  textDirection,
  type TranslationInfo,
} from "@quaso/core";
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ButtonLink } from "../../components/Button.tsx";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { SourceText } from "../../components/SourceText.tsx";
import { StateBadge } from "../../components/StateBadge.tsx";
import { useToast } from "../../components/Toast.tsx";
import { JobProgress } from "../../components/JobProgress.tsx";
import {
  ArgumentsNote,
  selectBlock,
  VaryByButtons,
  varyFieldSelection,
} from "./DeclaredArguments.tsx";
import { DocumentParagraphs } from "./DocumentParagraphs.tsx";
import { fieldEnglish, IcuCaseInput, useIcuFields } from "./IcuCaseEditor.tsx";
import { IcuPreviewList, PluralCaseHints, pluralCaseHints } from "./IcuHelp.tsx";
import { OutdatedNotice } from "./OutdatedNotice.tsx";
import { MarkdownPreview } from "../../lib/markdown.tsx";
import {
  ApiError,
  approveTranslation,
  createJob,
  deleteTranslation,
  getString,
  isApiError,
  saveTranslation,
  suggest,
  unapproveTranslation,
} from "../../lib/api.ts";
import { queryCache, useQuery } from "../../lib/data.ts";
import {
  documentName,
  formatDateTime,
  formatRelative,
  languageLabel,
  stringName,
  valueText,
} from "../../lib/format.ts";
import { useDebounced } from "../../lib/hooks.ts";
import {
  type Draft,
  draftFrom,
  editorMasking,
  englishFor,
  formExamples,
  type FormKey,
  formsFor,
  maskText,
  sameDraft,
  unmaskText,
  valueFrom,
} from "../../lib/masking.ts";
import { Link, href, useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { isMac } from "../../lib/shortcuts.ts";
import {
  type LlmSuggestionState,
  useLlmSuggestion,
  useLlmSuggestionsPreference,
} from "./useLlmSuggestion.ts";
import { keepUnsavedEdit, saveInBackground, unsavedEdit, useSaveState } from "./backgroundSaves.ts";

/** What the editor page asks of the panel, for the keyboard shortcuts. */
export interface PanelHandle {
  /** Saves (or suggests) if something changed, then goes to the next string. */
  saveAndNext(): void;
  /** Whether it did anything (not for people who can't write). */
  copySource(): boolean;
  /** Whether there was such a chip to insert. */
  insertChip(index: number): boolean;
  /** Puts the LLM's suggestion in the focused input; whether there was one to put. */
  takeLlmSuggestion(): boolean;
  focusInput(): void;
}

/** What ran into someone else's change: a save, or one of the actions on the translation. */
type Operation = "save" | "approve" | "unapprove" | "delete" | "approval";

interface Conflict {
  operation: Operation;
  /** The translation now, null when it was deleted, undefined when it couldn't be found. */
  current: TranslationInfo | null | undefined;
}

export interface TranslationPanelProps {
  ref?: Ref<PanelHandle>;
  id: number;
  language: LanguageProgress;
  project: ProjectInfo;
  /** The string as the list has it, to show at once while the details load. */
  summary?: StringSummary;
  /** The strings to do after this one: LLM suggestions are fetched for them ahead of time. */
  upcoming?: StringSummary[];
  onNext(): void;
  /** After a change: refresh these strings wherever they are shown. */
  onChanged(ids: number[]): Promise<void>;
  /** After starting an LLM job: poll faster for a while. */
  onJobStarted(): void;
  /** Focus the first input once the string is shown. */
  autoFocus?: boolean;
}

export function stringKey(id: number, language: string) {
  return ["string", id, language] as const;
}

export function TranslationPanel(props: TranslationPanelProps) {
  const { id, language } = props;
  const detail = useQuery<StringDetail>(
    stringKey(id, language.tag),
    ({ fresh }) => getString(id, language.tag, { fresh }),
    { staleTime: 5_000 },
  );
  const saveState = useSaveState(`${language.tag}:${id}`);
  if (saveState === "saving") return <Loading label="Saving the translation…" />;
  const data: StringDetail | undefined =
    detail.data ??
    (props.summary && {
      ...props.summary,
      language: language.tag,
      suggestions: [],
      glossary: [],
      otherLanguages: [],
      references: [],
      checks: [],
      arguments: [],
    });
  if (!data) {
    if (detail.error !== undefined) {
      return (
        <ErrorMessage
          error={detail.error}
          title="This string couldn't be loaded"
          onRetry={() => detail.refresh()}
        />
      );
    }
    return <Loading label="Loading the string…" />;
  }
  return (
    <Editor
      key={`${id}:${language.tag}`}
      {...props}
      detail={data}
      loaded={detail.data !== undefined}
    />
  );
}

/** How a document's translation is shown: the whole file, side by side by paragraph, or rendered. */
type DocumentView = "file" | "paragraphs" | "preview";

const DOCUMENT_VIEWS: { id: DocumentView; label: string }[] = [
  { id: "file", label: "Whole file" },
  { id: "paragraphs", label: "Side by side" },
  { id: "preview", label: "Preview" },
];

function Editor(props: TranslationPanelProps & { detail: StringDetail; loaded: boolean }) {
  const { detail, language, project } = props;
  const tag = language.tag;
  const session = useSession();
  const toast = useToast();
  const { location } = useRoute();
  const syntax = project.syntax;
  // Documents are Markdown first: their ICU gets the checks, not the case help.
  const icuStrings = syntax.icu === true && !detail.document;
  const direction = textDirection(tag);
  const current = detail.translation;
  const draftKey = `${tag}:${detail.id}`;

  const masking = useMemo(
    () => editorMasking(detail.source, detail.references, syntax, current?.value),
    [detail.source, detail.references, syntax, current?.value],
  );
  const mask = useCallback((text: string) => maskText(text, masking, syntax), [masking, syntax]);
  const unmask = useCallback((text: string) => unmaskText(text, masking), [masking]);
  const forms = useMemo(
    () => formsFor(detail.kind, tag, detail.source, language.plural),
    [detail.kind, tag, detail.source, language.plural],
  );

  const serverDraft = useMemo(
    () => draftFrom(current?.value, forms, mask),
    [current?.value, forms, mask],
  );
  const serverRevision = current?.revision ?? 0;
  const [edit, setEdit] = useState<{ draft: Draft; pristine: Draft; baseRevision: number } | null>(
    () => {
      const kept = unsavedEdit(draftKey);
      // A failed save's edit comes back even if the translation changed: saving asks then.
      const keep = kept && (kept.baseRevision === serverRevision || kept.error !== undefined);
      return keep
        ? { draft: kept.draft, pristine: serverDraft, baseRevision: kept.baseRevision }
        : null;
    },
  );
  /** Why this edit's background save failed, if it did. */
  const [failure] = useState(() => unsavedEdit(draftKey)?.error);
  // Pristine editors follow server data directly; unsaved edits retain their original revision.
  const localDirty = edit !== null && !sameDraft(edit.draft, edit.pristine, forms);
  const retain = edit !== null && (localDirty || edit.baseRevision === serverRevision);
  const draft = retain ? edit.draft : serverDraft;
  const pristine = retain ? edit.pristine : serverDraft;
  const baseRevision = retain ? edit.baseRevision : serverRevision;
  const dirty = !sameDraft(draft, pristine, forms);
  const icuFields = useIcuFields(
    icuStrings && detail.kind === "text" && typeof detail.source === "string"
      ? detail.source
      : null,
    unmask(draft.text ?? ""),
    unmask(pristine.text ?? ""),
    tag,
    language.plural,
  );
  const fieldsShown = icuFields?.shown === true;
  const [conflict, setConflict] = useState<Conflict | undefined>(() =>
    isApiError(failure, "conflict") && failure.current !== undefined
      ? { operation: "save", current: failure.current }
      : undefined,
  );
  const [actionError, setActionError] = useState<unknown>(() =>
    isApiError(failure, "conflict") ? undefined : failure,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [documentView, setDocumentView] = useState<DocumentView>("file");
  const inputs = useRef(new Map<FormKey, HTMLTextAreaElement>());
  const lastFocused = useRef<FormKey>(forms[0]);
  const root = useRef<HTMLDivElement>(null);
  // The case editor's field that last had focus, and its English: chips and copying go there.
  const focusedField = useRef<{
    element: HTMLTextAreaElement;
    english: string;
    field: IcuField;
  } | null>(null);

  // Keep an unsaved draft when moving to another string; forget it once saved.
  const latest = useRef({ draft, dirty, baseRevision });
  latest.current = { draft, dirty, baseRevision };
  const sentInBackground = useRef(false);
  useEffect(
    () => () => {
      // The background save keeps the edit itself, if it fails.
      if (sentInBackground.current) return;
      const { draft, dirty, baseRevision } = latest.current;
      keepUnsavedEdit(draftKey, dirty ? { draft, baseRevision, error: failure } : null);
    },
    [draftKey],
  );

  const changedMeanwhile = dirty && serverRevision !== baseRevision && conflict === undefined;

  const value = useMemo(() => valueFrom(draft, forms, unmask), [draft, forms, unmask]);
  const checks = useMemo((): CheckResult[] => {
    if (!dirty && !current) return [];
    if (!dirty) return detail.checks;
    try {
      return checkTranslation({
        kind: detail.kind,
        source: detail.source,
        translation: value,
        document: detail.document,
        language: tag,
        maxLength: detail.maxLength,
        syntax,
        pluralOverride: language.plural,
        glossary: detail.glossary,
        arguments: detail.arguments,
      });
    } catch {
      return [];
    }
  }, [
    dirty,
    current,
    detail.kind,
    detail.source,
    detail.document,
    value,
    tag,
    detail.maxLength,
    detail.glossary,
    detail.arguments,
    detail.checks,
    syntax,
    language.plural,
  ]);
  const errors = checks.filter((check) => check.severity === "error");
  const shownChecks = useDebounced(checks, 250);

  const canEdit = session.can("edit", tag);
  const canSuggest = !canEdit && session.can("suggest", tag);
  const canTranslate = session.can("translate", tag);
  const writable = canEdit || canSuggest;
  const colour = current?.colour ?? "red";

  const [suggestionsOn, setSuggestionsOn] = useLlmSuggestionsPreference();
  const canAskLlm = canEdit && project.llmAvailable;
  // Only strings to do: a current translation is already there to start from.
  const toDo = !current || current.outdated;
  const llm = useLlmSuggestion(
    tag,
    detail,
    props.upcoming ?? [],
    canAskLlm && suggestionsOn && toDo,
  );
  const llmDraft = useMemo(
    () => (llm.status === "ready" ? draftFrom(llm.suggestion.value, forms, mask) : null),
    [llm, forms, mask],
  );

  useEffect(() => {
    if (props.autoFocus) {
      const target = writable
        ? inputs.current.get(forms[0])
        : document.getElementById("panel-heading");
      target?.focus();
    }
    // Only when the string is first shown.
  }, []);

  const setForm = (form: FormKey, text: string) => {
    setEdit({ draft: { ...draft, [form]: text }, pristine, baseRevision });
    setActionError(undefined);
  };

  /** Inserts text at the cursor of the last focused input, keeping undo where possible. */
  const insert = (text: string, replaceAll = false): boolean => {
    const form = lastFocused.current ?? forms[0];
    const field = fieldsShown ? focusedField.current?.element : undefined;
    const element = field?.isConnected ? field : inputs.current.get(form);
    if (!element) return false;
    element.focus();
    if (replaceAll) element.select();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted && fieldsShown) {
      // A field's change handler writes the translation, so it must see the change.
      element.setRangeText(text, element.selectionStart, element.selectionEnd, "end");
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (!inserted) {
      // Without execCommand, change the value ourselves (undo then skips the insertion).
      const start = element.selectionStart;
      const next = element.value.slice(0, start) + text + element.value.slice(element.selectionEnd);
      setForm(form, next);
      requestAnimationFrame(() =>
        element.setSelectionRange(start + text.length, start + text.length),
      );
    }
    return true;
  };

  /** The text selected in the last focused input, for a tool that wraps it. */
  const selectedText = (): string => {
    const element = inputs.current.get(lastFocused.current ?? forms[0]);
    return element ? element.value.slice(element.selectionStart, element.selectionEnd) : "";
  };

  /** Writes a select block on an argument around the selection, in the input or a case field. */
  const varyBy = (argument: StringArgument): boolean => {
    const form = lastFocused.current ?? forms[0];
    if (!fieldsShown || !icuFields?.form) return insert(selectBlock(argument, selectedText()));
    const focused = focusedField.current?.element.isConnected ? focusedField.current : null;
    const field = focused?.field ?? icuFields.form.fields[0];
    const element = focused?.element ?? inputs.current.get(form);
    const caret = field.text.length;
    const selection = {
      start: element?.selectionStart ?? caret,
      end: element?.selectionEnd ?? caret,
    };
    const next = varyFieldSelection(icuFields.write, field, selection, argument);
    if (next === null) return false;
    // The fields follow the English's blocks, and this one isn't the English's: the
    // translation goes on as text.
    icuFields.keepText();
    setForm(form, mask(next));
    requestAnimationFrame(() => inputs.current.get(form)?.focus());
    return true;
  };

  /** Replaces a form's input with the LLM's text, keeping undo for what was typed. */
  const takeLlmSuggestion = (form: FormKey): boolean => {
    const text = llmDraft?.[form];
    if (text === undefined || !writable) return false;
    lastFocused.current = form;
    if (fieldsShown) {
      // The LLM translates the whole message, not one field.
      setForm(form, text);
      return true;
    }
    return insert(text, true);
  };

  /** The English of a form, with the cases its ICU plural blocks need in this language. */
  const englishToCopy = (form: FormKey): string => {
    const english = englishFor(detail.source, form);
    return syntax.icu ? icuWithLanguageCases(english, tag, language.plural) : english;
  };

  const copySource = (): boolean => {
    if (!writable) return false;
    const form = lastFocused.current ?? forms[0];
    if (fieldsShown && icuFields?.form) {
      const focused = focusedField.current;
      const focusedEnglish = focused?.element.isConnected ? focused.english : undefined;
      return insert(focusedEnglish ?? fieldEnglish(icuFields.form.fields[0]), true);
    }
    return insert(mask(englishToCopy(form)), true);
  };

  /**
   * After an action, the button that had focus may be gone (Approve, once approved) or
   * disabled: then focus goes to the first input, or the panel's heading, rather than
   * dropping to the page's body (WCAG 2.4.3).
   */
  const focusFallback = (): HTMLElement | null =>
    inputs.current.get(forms[0]) ?? document.getElementById("panel-heading");
  const keepFocus = (hadFocus: boolean) => {
    if (!hadFocus) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      focusFallback()?.focus();
    });
  };
  /** Focus is in the panel, not in its dialog (the dialog gives focus back itself). */
  const focusInPanel = () => {
    const active = document.activeElement;
    return (root.current?.contains(active) ?? false) && !active?.closest("dialog");
  };

  /** A 409: the conflict, with the current translation (asked for, if the error lacks it). */
  const conflictFrom = async (operation: Operation, error: ApiError): Promise<Conflict> => {
    if (error.current !== undefined) return { operation, current: error.current };
    try {
      const fresh = await getString(detail.id, tag, { fresh: true });
      return { operation, current: fresh.translation };
    } catch {
      return { operation, current: undefined };
    }
  };

  const after = async (message: string, next: boolean) => {
    keepUnsavedEdit(draftKey, null);
    toast.show(message);
    // The next string opens while the refresh runs, so a save waits for one round trip only.
    const refreshed = props.onChanged([detail.id]);
    if (next) props.onNext();
    await refreshed;
  };

  const submit = async (revision = baseRevision) => {
    if (!writable) return;
    if (errors.length > 0) {
      // The errors are listed under the input, where focus goes: the toast only points there.
      toast.show(`Fix the errors first: ${errors[0].message}`, "info");
      const form = (errors[0].form ?? forms[0]) as FormKey;
      (inputs.current.get(form) ?? inputs.current.get(forms[0]))?.focus();
      return;
    }
    // A string that changed meanwhile, or whose save failed, saves here: the answer needs reading.
    const needsAttention = changedMeanwhile || conflict !== undefined || failure !== undefined;
    if (!needsAttention) {
      sendAndContinue(revision);
      return;
    }
    const hadFocus = focusInPanel();
    setBusy("save");
    setActionError(undefined);
    try {
      await send(revision);
      setEdit({ draft, pristine: draft, baseRevision: revision });
      setConflict(undefined);
      await after(
        canEdit
          ? "Saved. It is proofread (blue) now."
          : "Suggestion sent. A manager will review it.",
        true,
      );
    } catch (error) {
      if (isApiError(error, "conflict")) setConflict(await conflictFrom("save", error));
      else setActionError(error);
    } finally {
      setBusy(null);
      keepFocus(hadFocus);
    }
  };

  const send = (revision: number) =>
    canEdit
      ? saveTranslation(detail.id, tag, { value, baseRevision: revision })
      : suggest(detail.id, tag, {
          kind: current ? "correction" : "translation",
          value,
          baseRevision: revision,
        });

  /** Opens the next string while the save runs; a failed save keeps the edit for later. */
  const sendAndContinue = (revision: number) => {
    const name = stringName(detail.file, detail.key);
    sentInBackground.current = true;
    saveInBackground(
      draftKey,
      { draft, baseRevision: revision },
      () => send(revision),
      async () => {
        const key = stringKey(detail.id, tag);
        await Promise.all([
          queryCache.fetch(key, () => getString(detail.id, tag, { fresh: true }), { force: true }),
          props.onChanged([detail.id]),
        ]);
      },
    ).then(
      () =>
        toast.show(
          canEdit
            ? `Saved ${name}: proofread (blue) now.`
            : `Suggestion for ${name} sent. A manager will review it.`,
        ),
      () => toast.show(`${name} wasn't saved. Open it to try again.`, "error"),
    );
    props.onNext();
  };

  const saveAndNext = () => {
    if (busy) return;
    if (!dirty || !writable) props.onNext();
    else submit();
  };

  /** The actions on the translation as it is: each sends the revision it applies to. */
  const operations: Record<
    Exclude<Operation, "save">,
    { retry: string; run(revision: number): Promise<unknown>; done: string }
  > = {
    approve: {
      retry: "Approve their version",
      run: (revision) => approveTranslation(detail.id, tag, { baseRevision: revision }),
      done: "Approved: proofread (blue) now.",
    },
    unapprove: {
      retry: "Unapprove their version",
      run: (revision) => unapproveTranslation(detail.id, tag, { baseRevision: revision }),
      done: "Unapproved: translated (green) now.",
    },
    delete: {
      retry: "Delete their version",
      run: (revision) => deleteTranslation(detail.id, tag, { baseRevision: revision }),
      done: "Deleted: the string is untranslated (red) now.",
    },
    approval: {
      retry: "Their version looks good",
      run: (revision) => suggest(detail.id, tag, { kind: "approval", baseRevision: revision }),
      done: "Thanks! Your “looks good” waits for a manager's review.",
    },
  };

  const action = async (operation: Exclude<Operation, "save">, revision = baseRevision) => {
    const hadFocus = focusInPanel();
    setBusy(operation);
    setActionError(undefined);
    try {
      await operations[operation].run(revision);
      setConflict(undefined);
      await after(operations[operation].done, false);
    } catch (error) {
      if (isApiError(error, "conflict")) setConflict(await conflictFrom(operation, error));
      else setActionError(error);
    } finally {
      setBusy(null);
      keepFocus(hadFocus);
    }
  };

  const translateWithLlm = async () => {
    const hadFocus = focusInPanel();
    setBusy("llm");
    setActionError(undefined);
    try {
      const result = await createJob({ strings: [detail.id], languages: [tag], retranslate: true });
      if (result.job) setJobId(result.job.id);
      toast.show("The LLM is translating this string. It turns green when it is done.", "info");
      props.onJobStarted();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(null);
      keepFocus(hadFocus);
    }
  };

  /**
   * Their version replaces what's shown. When it couldn't be loaded, the string is fetched
   * again and the edit stays: saving it then asks again which version to keep.
   */
  const takeTheirs = () => {
    const current = conflict?.current;
    if (current !== undefined) {
      const theirs = draftFrom(current?.value, forms, mask);
      setEdit({ draft: theirs, pristine: theirs, baseRevision: current?.revision ?? 0 });
    }
    setConflict(undefined);
    props.onChanged([detail.id]);
    requestAnimationFrame(() => focusFallback()?.focus());
  };

  useImperativeHandle(props.ref, () => ({
    saveAndNext,
    copySource,
    insertChip: (index: number) => {
      const chip = masking.chips[index];
      return chip !== undefined && writable && insert(chip.insert);
    },
    takeLlmSuggestion: () => takeLlmSuggestion(lastFocused.current ?? forms[0]),
    focusInput: () => inputs.current.get(lastFocused.current ?? forms[0])?.focus(),
  }));

  const checksFor = (form: FormKey) =>
    forms.length === 1 ? shownChecks : shownChecks.filter((check) => check.form === form);
  const generalChecks = forms.length > 1 ? shownChecks.filter((check) => !check.form) : [];

  const sourceDirection = textDirection(project.sourceLanguage);
  // Placeholders and references the checks find missing, so their chips can say so.
  const missing = new Set(
    shownChecks
      .filter(
        (check) => check.check === "placeholder_missing" || check.check === "reference_missing",
      )
      .map((check) => check.value),
  );
  const chipMissing = (chip: (typeof masking.chips)[number]) => missing.has(chip.key);

  return (
    <div className="panel" ref={root}>
      <div className="panel-head">
        <H2 ui id="panel-heading" className="panel-key" tabIndex={-1}>
          <span className="sr-only">String</span>{" "}
          <code>{detail.document ? documentName(detail.file) : detail.key}</code>
        </H2>
        <p className="panel-file muted">
          {detail.file}
          {detail.document && " · a whole file, translated as one text"}
          {detail.kind !== "text" && (
            <>
              {" · "}
              {detail.kind === "plural" ? "plural" : "ordinal plural"}
            </>
          )}
        </p>
        <StateBadge summary={detail} describe />
      </div>

      {detail.description.trim() !== "" && (
        <p className="panel-description">{detail.description}</p>
      )}
      {detail.maxLength !== null && (
        <p className="panel-limit">
          <InfoIcon /> At most {detail.maxLength} characters.
        </p>
      )}

      <OutdatedNotice
        detail={detail}
        sourceLanguage={project.sourceLanguage}
        sourceLanguageName={project.sourceLanguageName}
        canEdit={canEdit}
        canSuggest={canSuggest}
      />

      <section className="panel-source" aria-labelledby="source-heading">
        <div className="panel-section-head">
          <H3 ui id="source-heading" className="panel-label">
            Source
          </H3>
          <span className="muted small">{project.sourceLanguageName}</span>
        </div>
        {typeof detail.source === "string" ? (
          <p className="source" lang={project.sourceLanguage} dir={sourceDirection}>
            <SourceText
              text={detail.source}
              syntax={syntax}
              masking={masking}
              glossary={detail.glossary}
              tree={!detail.document}
            />
          </p>
        ) : (
          <dl className="source-forms">
            {Object.entries(detail.source).map(([form, text]) => (
              <div key={form}>
                <dt>{form}</dt>
                <dd lang={project.sourceLanguage} dir={sourceDirection}>
                  <SourceText
                    text={text ?? ""}
                    syntax={syntax}
                    masking={masking}
                    glossary={detail.glossary}
                    tree
                  />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {detail.arguments.length > 0 && <ArgumentsNote declared={detail.arguments} />}
        {detail.identicalSources && detail.identicalSources.length > 0 && (
          <p className="panel-hint">
            Same source as{" "}
            {detail.identicalSources.map((peer, index) => (
              <span key={peer.id}>
                {index > 0 && ", "}
                <Link to={`/translate/${tag}?id=${peer.id}`}>
                  <code>{stringName(peer.file, peer.key)}</code>
                </Link>
              </span>
            ))}
            . Review these together when changing the wording.
          </p>
        )}
        {masking.enabled && masking.references.length > 0 && (
          <p className="panel-hint muted">
            ⟦1⟧, ⟦2⟧… stand for references to other strings; they turn back into the exact{" "}
            <code>$t(…)</code> text when saved.
          </p>
        )}
      </section>

      {detail.sourceWarnings?.map((warning, index) => (
        <Notice key={index} kind="warning" title="Ambiguous source">
          <p>{warning.message}</p>
          <p>
            Add a description explaining the intended meaning before translating other languages.
          </p>
        </Notice>
      ))}
      {!writable && (
        <ReadOnly
          detail={detail}
          language={language}
          sourceLanguageName={project.sourceLanguageName}
          syntax={icuStrings ? syntax : undefined}
          next={location.pathname + location.search}
        />
      )}
      {detail.meaningJobId && session.can("translate", tag) && (
        <QualityJobProgress id={detail.meaningJobId} onDone={() => props.onChanged([detail.id])} />
      )}
      <QualityCheckButton
        language={tag}
        file={detail.file}
        strings={[detail.id]}
        onChecked={() => props.onChanged([detail.id])}
      />
      {jobId !== null && (
        <JobProgress
          id={jobId}
          onDone={() => {
            props.onChanged([detail.id]);
          }}
        />
      )}

      {writable && (
        <section className="panel-edit" aria-labelledby="edit-heading">
          <div className="panel-section-head">
            <H3 ui id="edit-heading" className="panel-label">
              {canEdit ? "Translation" : "Your suggestion"} ({language.name})
            </H3>
            {dirty && (
              <span className="panel-draft-state" role="status">
                Unsaved changes
              </span>
            )}
          </div>
          <div className="panel-assist" role="group" aria-label="Translation tools">
            <Button
              size="small"
              variant="ghost"
              icon={<CopyIcon />}
              onClick={copySource}
              title="Ctrl+Shift+C"
            >
              Copy the {project.sourceLanguageName}
            </Button>
            {canTranslate && !(colour === "blue" && !current?.outdated) && (
              <Button
                size="small"
                variant="ghost"
                icon={<SparklesIcon />}
                busy={busy === "llm"}
                disabled={!project.llmAvailable || busy !== null}
                aria-describedby={project.llmAvailable ? undefined : "llm-off"}
                onClick={translateWithLlm}
              >
                Translate with the LLM
              </Button>
            )}
            <VaryByButtons declared={detail.arguments} onVary={varyBy} />
            {canAskLlm && (
              <Label className="llm-switch">
                <Switch
                  checked={suggestionsOn}
                  onChange={(event) => setSuggestionsOn(event.target.checked)}
                />{" "}
                LLM suggestions
              </Label>
            )}
          </div>
          {masking.chips.length > 0 && (
            <div
              className="chips"
              role="group"
              aria-label="Placeholders and references: click to insert"
            >
              {masking.chips.map((chip, index) => {
                const isMissing = chipMissing(chip);
                const missingNote = isMissing ? " (missing from the translation)" : "";
                return (
                  <Chip
                    key={`${chip.kind}:${chip.raw}`}
                    kind={chip.kind}
                    className={isMissing ? "chip-missing" : undefined}
                    shortcut={index < 9 ? index + 1 : undefined}
                    title={
                      chip.kind === "reference"
                        ? `${chip.insert} = ${chip.raw}${chip.english ? `: “${chip.english}”` : ""}${missingNote}`
                        : `Insert ${chip.raw}${missingNote}`
                    }
                    aria-label={
                      chip.kind === "reference"
                        ? `Insert reference ${chip.insert}, ${chip.raw}${
                            chip.english ? `: ${chip.english}` : ""
                          }${missingNote}`
                        : `Insert placeholder ${chip.raw}${missingNote}`
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insert(chip.insert)}
                  >
                    {isMissing && <WarningIcon />}
                    {chip.insert}
                  </Chip>
                );
              })}
            </div>
          )}
          {forms.map((form) => {
            const inputId = `translation-${form}`;
            const examples = formExamples(form, detail.kind, tag, detail.source);
            const text = draft[form] ?? "";
            const length = detail.maxLength !== null ? graphemeLength(unmask(text)) : 0;
            const formChecks = checksFor(form);
            const invalid = errors.some((e) => forms.length === 1 || e.form === form);
            const english = englishFor(detail.source, form);
            const caseHints = icuStrings ? pluralCaseHints(english, tag, language.plural) : [];
            const describedBy = [
              `${inputId}-checks`,
              detail.maxLength !== null && `${inputId}-length`,
              caseHints.length > 0 && `${inputId}-cases`,
            ];
            const describedByIds = describedBy.filter(Boolean).join(" ");
            const singleLine = !/[\r\n]/.test(english);
            const textInput = (
              <TextArea
                id={inputId}
                ref={(element) => {
                  if (element) inputs.current.set(form, element);
                  else inputs.current.delete(form);
                }}
                lang={tag}
                dir={direction}
                data-translation-input=""
                value={text}
                minRows={form !== "text" ? 2 : detail.document ? 8 : 3}
                spellCheck
                aria-invalid={invalid || undefined}
                aria-describedby={describedByIds}
                onFocus={() => (lastFocused.current = form)}
                onChange={(event) => {
                  setForm(form, event.target.value);
                  icuFields?.keepText();
                }}
                onKeyDown={(event) => {
                  const composing = event.nativeEvent.isComposing;
                  const saveShortcut = event.ctrlKey || event.metaKey;
                  if (event.key === "Enter" && singleLine && !composing && !saveShortcut) {
                    event.preventDefault();
                  }
                }}
              />
            );
            const input =
              icuFields !== null && form === "text" ? (
                <IcuCaseInput
                  fields={icuFields}
                  text={unmask(text)}
                  textInput={textInput}
                  inputId={inputId}
                  language={tag}
                  direction={direction}
                  sourceLanguage={project.sourceLanguage}
                  sourceDirection={sourceDirection}
                  invalid={invalid}
                  describedBy={describedByIds}
                  singleLine={singleLine}
                  firstFieldRef={(element) => {
                    if (element) inputs.current.set(form, element);
                    else inputs.current.delete(form);
                  }}
                  onFieldFocus={(element, fieldText, field) => {
                    lastFocused.current = form;
                    focusedField.current = { element, english: fieldText, field };
                  }}
                  onChange={(next) => setForm(form, mask(next))}
                />
              ) : (
                textInput
              );
            return (
              <div key={form} className="form-input">
                <Label htmlFor={inputId} className="input-label">
                  {form === "text" ? (
                    `Translation into ${language.name}`
                  ) : (
                    <>
                      <span className="sr-only">Plural form</span>{" "}
                      <span className="form-name">{form}</span>
                      {examples && (
                        <span className="form-examples">
                          <span className="sr-only">, for</span> {examples}
                        </span>
                      )}
                    </>
                  )}
                </Label>
                {form !== "text" && (
                  <p
                    className="input-english muted"
                    lang={project.sourceLanguage}
                    dir={sourceDirection}
                  >
                    <SourceText text={english} syntax={syntax} masking={masking} tree />
                  </p>
                )}
                <PluralCaseHints
                  id={`${inputId}-cases`}
                  hints={caseHints}
                  languageName={language.name}
                />
                {detail.document && typeof detail.source === "string" ? (
                  <Tabs
                    label="How to show the document"
                    tabs={DOCUMENT_VIEWS}
                    selected={documentView}
                    onSelect={(id) => setDocumentView(id as DocumentView)}
                  >
                    {documentView === "file" && input}
                    {documentView === "paragraphs" && (
                      <DocumentParagraphs
                        english={detail.source}
                        text={text}
                        onChange={(next) => setForm(form, next)}
                        onFocusInput={(element) => {
                          inputs.current.set(form, element);
                          lastFocused.current = form;
                        }}
                        language={tag}
                        languageName={language.name}
                        direction={direction}
                        sourceLanguage={project.sourceLanguage}
                        sourceDirection={sourceDirection}
                      />
                    )}
                    {documentView === "preview" && (
                      <MarkdownPreview text={text} lang={tag} dir={direction} />
                    )}
                  </Tabs>
                ) : (
                  input
                )}
                {detail.document && typeof detail.source === "string" && (
                  <ParagraphCounter english={detail.source} text={text} />
                )}
                {detail.maxLength !== null && (
                  <p
                    id={`${inputId}-length`}
                    className={`length${length > detail.maxLength ? " length-over" : ""}`}
                  >
                    {length > detail.maxLength && <WarningIcon />}
                    {length} / {detail.maxLength} <span className="sr-only">characters</span>
                  </p>
                )}
                {canAskLlm && suggestionsOn && (
                  <LlmOffer
                    state={llm}
                    text={llmDraft?.[form]}
                    typed={text}
                    // Waiting and failures are said once, under the first input.
                    first={form === forms[0]}
                    language={tag}
                    direction={direction}
                    onTake={() => takeLlmSuggestion(form)}
                  />
                )}
                <CheckList id={`${inputId}-checks`} checks={formChecks} />
                {icuStrings && (
                  <IcuPreviewList
                    text={unmask(text)}
                    language={tag}
                    override={language.plural}
                    dir={direction}
                  />
                )}
              </div>
            );
          })}
          {forms.length > 1 && <CheckList checks={generalChecks} />}

          {changedMeanwhile && (
            <Notice
              kind="warning"
              icon={<InfoIcon />}
              title="Someone changed this translation meanwhile"
            >
              <p>Saving now will ask you which version to keep.</p>
            </Notice>
          )}
          {conflict !== undefined && (
            <ConflictNotice
              conflict={conflict}
              language={tag}
              direction={direction}
              busy={busy}
              retryLabel={
                conflict.operation === "save"
                  ? "Save mine over it"
                  : operations[conflict.operation].retry
              }
              onTakeTheirs={takeTheirs}
              onRetry={(revision) =>
                conflict.operation === "save"
                  ? submit(revision)
                  : action(conflict.operation, revision)
              }
            />
          )}
          {actionError !== undefined && <ErrorMessage error={actionError} />}

          <div className="panel-actions">
            <Button
              variant={dirty ? "primary" : "secondary"}
              busy={busy === "save"}
              disabled={!dirty || errors.length > 0 || busy !== null}
              onClick={() => submit()}
              aria-describedby={errors.length > 0 ? "save-blocked" : undefined}
              title={
                canEdit
                  ? "Save and go to the next string to do"
                  : "Suggest and go to the next string to do"
              }
            >
              {canEdit ? "Save" : "Suggest"}
            </Button>
            {canSuggest && colour === "green" && !dirty && (
              <Button
                variant="primary"
                busy={busy === "approval"}
                disabled={busy !== null}
                icon={<CheckSquareIcon />}
                onClick={() => action("approval")}
              >
                Looks good
              </Button>
            )}
            {canEdit && !dirty && (colour === "green" || current?.outdated) && (
              <Button
                variant="primary"
                busy={busy === "approve"}
                disabled={busy !== null}
                icon={<CheckSquareIcon />}
                title={
                  current?.outdated
                    ? `Confirm that the translation still fits the new ${project.sourceLanguageName}`
                    : undefined
                }
                onClick={() => action("approve")}
              >
                Approve
              </Button>
            )}
            {!dirty && (
              <Button variant="ghost" disabled={busy !== null} onClick={props.onNext}>
                Next to do
              </Button>
            )}
            <span className="panel-save-hint">
              {canEdit ? "Save" : "Suggest"} & continue <Kbd>Ctrl / ⌘ + Enter</Kbd>
            </span>
          </div>
          {canEdit && current && !dirty && (
            <div className="panel-maintenance" role="group" aria-label="Manage this translation">
              {colour === "blue" && (
                <Button
                  size="small"
                  variant="ghost"
                  busy={busy === "unapprove"}
                  disabled={busy !== null}
                  icon={<UndoIcon />}
                  onClick={() => action("unapprove")}
                >
                  Unapprove
                </Button>
              )}
              <Button
                size="small"
                variant="ghost"
                className="btn-danger-text"
                icon={<TrashIcon />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            </div>
          )}
          {errors.length > 0 && (
            <p id="save-blocked" className="field-error">
              {canEdit ? "Saving" : "Suggesting"} waits until the errors are fixed.
            </p>
          )}
          {canTranslate && !project.llmAvailable && (
            <p id="llm-off" className="muted small">
              LLM translation is off: this server has no LLM provider.
            </p>
          )}
          {dirty && (
            <Button
              variant="plain"
              type="button"
              className="link-button small"
              onClick={() => setEdit(null)}
            >
              Undo my changes
            </Button>
          )}
        </section>
      )}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this translation?"
        size="small"
        // Once deleted, the Delete button that opened the dialog is gone.
        returnFocus={focusFallback}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} data-autofocus="">
              Keep it
            </Button>
            <Button
              variant="danger"
              busy={busy === "delete"}
              onClick={async () => {
                await action("delete");
                setConfirmDelete(false);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>
          The {language.name} translation of{" "}
          <code>{detail.document ? documentName(detail.file) : detail.key}</code> goes, and the app
          shows the {project.sourceLanguageName} until someone translates it again. Its history
          stays.
        </p>
      </Dialog>
    </div>
  );
}

/**
 * What happened when a save or an action met someone else's change: their version, and the
 * choice between it and doing what was asked anyway, on their version's revision. After a
 * save, "anyway" saves the edit over theirs; after Approve, Unapprove, Delete or "Looks
 * good", it applies that action to their version, never the older text.
 */
function ConflictNotice({
  conflict,
  language,
  direction,
  busy,
  retryLabel,
  onTakeTheirs,
  onRetry,
}: {
  conflict: Conflict;
  language: string;
  direction: "ltr" | "rtl";
  busy: string | null;
  retryLabel: string;
  onTakeTheirs(): void;
  onRetry(revision: number): void;
}) {
  const { operation, current } = conflict;
  const save = operation === "save";
  return (
    <div className="notice notice-warning" role="alert">
      <WarningIcon className="notice-icon" />
      <div className="notice-body">
        <p className="notice-title">
          {save
            ? "Someone changed this translation while you were editing it."
            : "Someone changed this translation meanwhile."}
        </p>
        {current === undefined ? (
          <p>Their version couldn't be loaded. Reload it, then decide.</p>
        ) : current === null ? (
          <p>It was deleted: the string is untranslated now.</p>
        ) : (
          <>
            <p>
              Their version, by {current.author.name},{" "}
              <time title={formatDateTime(current.updatedAt)}>
                {formatRelative(current.updatedAt)}
              </time>
              :
            </p>
            <blockquote className="conflict-text" lang={language} dir={direction}>
              {valueText(current.value)}
            </blockquote>
          </>
        )}
        <div className="actions">
          <Button size="small" onClick={onTakeTheirs}>
            {save && current !== undefined ? "Use their version" : "Reload"}
          </Button>
          {
            // Saving over a deleted translation creates it again; the other actions need a
            // translation, and a revision to apply to.
            current !== undefined && (save || current !== null) && (
              <Button
                size="small"
                variant={operation === "delete" ? "danger" : "primary"}
                busy={busy === operation}
                disabled={busy !== null}
                onClick={() => onRetry(current?.revision ?? 0)}
              >
                {retryLabel}
              </Button>
            )
          }
        </div>
      </div>
    </div>
  );
}

/**
 * The LLM's translation of one form, under its input: a click (or Ctrl+Shift+Enter) puts it
 * in the input. Hidden while the input already says the same.
 */
function LlmOffer({
  state,
  text,
  typed,
  first,
  language,
  direction,
  onTake,
}: {
  state: LlmSuggestionState;
  text: string | undefined;
  typed: string;
  first: boolean;
  language: string;
  direction: "ltr" | "rtl";
  onTake(): void;
}) {
  const shortcut = isMac() ? "⌘⇧↩" : "Ctrl+Shift+Enter";
  const offered = state.status === "ready" && text !== undefined && text !== typed;
  return (
    // Always in the page, so that the suggestion's arrival is announced.
    <div className="llm-offer" aria-live="polite">
      {state.status === "loading" && first && (
        <p className="llm-offer-note">
          <SpinnerIcon /> The LLM is translating this string…
        </p>
      )}
      {state.status === "failed" && first && (
        <p className="llm-offer-note">
          <InfoIcon /> No LLM suggestion: {state.message}
        </p>
      )}
      {offered && (
        <Button
          variant="plain"
          className="llm-offer-button"
          title={`Use the LLM's translation (${shortcut})`}
          // Focus stays in the input, which the click fills.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onTake}
        >
          <span className="llm-offer-label">
            <SparklesIcon /> LLM suggestion <span className="llm-offer-key">{shortcut}</span>
          </span>
          <span className="llm-offer-text" lang={language} dir={direction}>
            {text}
          </span>
        </Button>
      )}
    </div>
  );
}

function CheckList({ id, checks }: { id?: string; checks: CheckResult[] }) {
  // Always in the page, even empty: a live region that appears together with its first
  // message is often not announced, and the first message is the error that blocks saving.
  return (
    <ul id={id} className="checks" aria-live="polite">
      {checks.map((check, index) => (
        <li
          key={`${check.check}:${check.form ?? ""}:${check.value ?? ""}:${index}`}
          className={`check check-${check.severity}`}
        >
          {check.severity === "error" ? <WarningIcon /> : <InfoIcon />}
          <span>
            <span className="sr-only">{check.severity === "error" ? "Error: " : "Warning: "}</span>
            {check.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** For people who can't write in this language: the translation, and how to take part. */
function ReadOnly({
  detail,
  language,
  sourceLanguageName,
  syntax,
  next,
}: {
  detail: StringDetail;
  language: LanguageProgress;
  sourceLanguageName: string;
  /** An ICU project's syntax: blocks then show as a tree. */
  syntax?: InterpolationSyntax;
  next: string;
}) {
  const session = useSession();
  const current = detail.translation;
  const direction = textDirection(language.tag);
  const languages = session.user?.languages;
  return (
    <section className="panel-edit" aria-labelledby="edit-heading">
      <H3 ui id="edit-heading" className="panel-label">
        Translation ({language.name})
      </H3>
      {current ? (
        <p className="translation-text" lang={language.tag} dir={direction}>
          {typeof current.value === "string" ? (
            syntax ? (
              <SourceText text={current.value} syntax={syntax} tree />
            ) : (
              current.value
            )
          ) : (
            <span className="plural-forms">
              {Object.entries(current.value).map(([form, text]) => (
                <span key={form} className="plural-form">
                  <span className="form-name" lang="en" dir="ltr">
                    {form}
                  </span>{" "}
                  {text}
                </span>
              ))}
            </span>
          )}
        </p>
      ) : (
        <p className="muted">Not translated yet: the app shows the {sourceLanguageName}.</p>
      )}
      {!session.user ? (
        <div className="signin-prompt">
          <UserIcon />
          <p>Sign in to suggest a translation.</p>
          <ButtonLink to={href("/signin", { next })} variant="primary" size="small">
            Sign in
          </ButtonLink>
        </div>
      ) : languages && languages.length > 0 && session.user.role !== "none" ? (
        <p className="signin-prompt">
          You can take part in {languages.map(languageLabel).join(", ")}.
        </p>
      ) : (
        <p className="signin-prompt">
          You can read everything. To suggest translations, an administrator needs to make you a
          contributor.
        </p>
      )}
    </section>
  );
}

/** A document's paragraphs typed so far against the English's, beside the input. */
function ParagraphCounter({ english, text }: { english: string; text: string }) {
  const expected = paragraphCount(english);
  const found = paragraphCount(text);
  const differs = text.trim() !== "" && found !== expected;
  return (
    <p className={`length${differs ? " length-over" : ""}`}>
      {differs && <WarningIcon />}
      {found} / {expected} paragraphs
    </p>
  );
}
