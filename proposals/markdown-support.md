# Proposal: Markdown documents, next steps

Status: proposed. Builds on #60, which made a `.md` or `.markdown` file a **document**: one
string translated whole, in a request of its own, with a `paragraphs` check that keeps the
number of blank-line-separated blocks. This proposal keeps that model. Keeping a whole file
in one string gives the model the whole article as context, and it gives proofreaders one
unit to approve. It lists what the model doesn't cover yet, most valuable first.

## 1. Updates send the English the translation was made for

When the English of a document changes, its translation becomes outdated, and the job sends
`outdatedTranslation` with the new English (`packages/service/src/llm/prompt.ts`). The
prompt doesn't include the English that translation was made for. For a JSON string that
hardly matters. For a 2,000-word article where one sentence changed, the model has to work
out what changed by comparing a translation with the new English. It may then rewrite
paragraphs nobody touched, in a green translation nobody will look at again.

- Add `outdatedEnglish` (the English the translation was made for, from the string's history,
  as `OutdatedNotice` already shows it) to the prompt line. The rule reads: "change only what
  the English change requires; keep everything else as it is."
- A warning check, `untouched_paragraph_changed`: paragraph _i_ of the translation changed
  although paragraph _i_ of the English didn't. Paragraph counts already match, so the
  paragraphs pair up by position.

## 2. What must not change is checked

The `paragraphs` check catches merged or split blocks, but not text that should have been
kept as it is. The checks don't catch a translated code block, a localised URL, or a
translated front matter key (`title:` → `titre:`). Add two errors, which only run on documents:

| Check                | Fails when                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown_verbatim`  | a fenced code block, inline code span, link or image destination, HTML tag or front matter key of the English is missing from the translation, or appears a different number of times |
| `markdown_structure` | paragraph _i_ doesn't start with the same block marker as in the English: heading level (`#`, `##`), list (`-`, `1.`), quote (`>`), table (`\|`), fence or front matter (`---`)       |

A refused answer goes back to the model with the reasons, as now, so both checks also make
the LLM correct itself. The prompt rule names the same things.

## 3. A measured size limit

A document is one request with a 3-minute timeout per attempt (`gemini.ts`) and two retries.
Nobody has measured how long a document can be before the answer is cut off or times out. A
document past that size fails three times, and each attempt is paid for.

- Measure the default model with 1k, 3k, 6k and 10k-word Markdown files: the time, output
  tokens, and whether the answer passes the checks.
- Set a documented maximum (in words) slightly below what passes reliably. `upload` warns
  about any document above it, and jobs skip it with a clear failure ("split this file, or
  translate it in the editor") instead of three paid timeouts.
- Splitting a long document into sections (by top-level heading), translated in sequence and
  joined into one value, is a later option. Choose it only if the measurement shows real
  files above the limit.

## 4. Proofreading a long document

The editor shows a document in a textarea eight rows high, with a paragraph counter. That
fits a short news post and not a help page. The paragraph counts match, so a document can be
shown paragraph by paragraph:

- A **side-by-side view** in the editor and on the review page: English paragraph _i_ next to
  translation paragraph _i_. Editing a paragraph edits that part of the value.
- On an outdated or proposed document, the existing word diff (`packages/web/src/lib/diff.ts`)
  per paragraph, so the reviewer reads only the paragraphs that changed.
- A **rendered preview** toggle (headings, lists, links, tables), since translators of game
  news read the result, not the syntax.

## 5. Heading anchors

Translating `## Installation` changes the anchor GitHub and most renderers generate
(`#installation` → `#instalación`), so `[see below](#installation)` in the same file stops
working. Add a warning check that names in-document links to headings, and a rule in the
prompt: rewrite such fragments to the translated heading's slug. Document the explicit
`{#id}` alternative for renderers that support it.

## Tasks, in order

1. `outdatedEnglish` in the prompt line and the "change only what changed" rule (§1). Add a
   prompt snapshot test and a fake-provider job test where one paragraph changes.
2. `markdown_verbatim` and `markdown_structure` (§2). Write one test per construct: code
   fence, inline code, link destination, image, HTML tag, front matter key, each block marker.
3. `untouched_paragraph_changed` (§1).
4. Measure document size and set the limit (§3). Record the numbers in this file.
5. Side-by-side paragraph view and per-paragraph diffs (§4). Add an e2e test that edits
   paragraph 2 of a three-paragraph document.
6. Rendered preview (§4).
7. Heading anchor check and prompt rule (§5).
8. Docs: the new checks in `docs/website.md`, and the size limit in `docs/add-to-your-game.md`.

## Open question

Should `markdown_structure` treat a list whose items are reordered as an error or a warning?
Some languages reorder list items for natural order, but rarely in game texts.
