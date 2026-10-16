# Proposal: Markdown files

Status: proposed. Quaso reads and writes i18next JSON only. The CLI refuses any other file
(`readme.md isn't a .json file`), and the requirements list Markdown as a "may, later" item
(FMT-5). This document describes what Markdown support needs, and lists the work in order.

Markdown in a game project means store descriptions, patch notes, help pages, in-game books,
press kits and the game's website. These files are long and are written as prose, and a
reader reads them top to bottom. JSON strings are short and independent.

## 1. Decisions

### 1.1 A Markdown file is a list of blocks, not one string

The file isn't sent whole. Sending a whole file as one string would hit the LLM's output
limit on long files. It would also take away everything the platform does per string:
colours, review, outdated flags, history, the length check and partial re-translation after
an edit. Crowdin, Weblate and po4a split documents into segments for the same reasons.

A block is one of the following. Each becomes one `text` entry:

| Markdown                               | Entry                                       |
| -------------------------------------- | ------------------------------------------- |
| Paragraph                              | one entry; soft line breaks become spaces   |
| ATX or setext heading                  | one entry, without the `#` markers          |
| List item (its first paragraph)        | one entry; nested blocks are their own      |
| Block quote paragraph                  | one entry, without the `>` markers          |
| GFM table cell                         | one entry per non-empty cell                |
| Front matter value named in the config | one entry (`title`, `description`)          |
| Image alt text and link titles         | part of their paragraph's entry             |

Some blocks are copied as they are, as `literal` entries that translators never see: fenced
and indented code, HTML blocks, thematic breaks, link reference definitions, table delimiter
rows, front matter keys that aren't named, and blank lines. **Anything the reader doesn't
recognise is copied as it is.** A misread construct therefore stays in English and never
breaks the file.

### 1.2 Batching stays, measured in words as well as strings

Batching still works with blocks: the job runner already sends neighbouring strings of one
file in one request (`batchesOf` in `packages/service/src/jobs/work.ts`), in file order.
`batchSize: 25` counts strings, though, and a paragraph can be 300 words. The fix:

- Add `batchWords` to the LLM settings, default 1,500 source words. A batch closes when either
  limit is reached. A single block above the limit goes alone. `WorkItem.words` already holds
  the count.
- Keep a document's batches in order, so the model sees the text as a reader does. The
  existing `neighbours` setting gives the text around the first and last strings of a batch.

### 1.3 A block's identity comes from aligning uploads

JSON strings have keys. Blocks don't, and a block's position changes whenever a paragraph is
inserted above it. Keys made from positions would mark every following block as removed and
added, and their translations would be lost. Keys made from content would make every edit a
removal plus an addition, so a fixed typo would lose the translation instead of marking it
outdated.

The server should align the uploaded block sequence with the stored one instead:

1. Match blocks with identical English (source hash), in order: the longest common
   subsequence of hashes.
2. Between two matched anchors, pair the remaining old and new blocks of the same kind
   (paragraph with paragraph, heading with heading) in order. Paired blocks are `changed`:
   they keep their ID and translations, which become outdated. They don't keep them when the
   texts are less than about 50% similar (word-level). Those blocks are a removal plus an
   addition.
3. Everything else is added or removed, as today.

Stored keys are opaque and stable (`md:<id>`). The display key is the heading trail plus a
short excerpt, such as `Installation › Windows › "Run the installer…"`. `diffSourceStrings`
(`packages/service/src/source_diff.ts`) keeps its key matching for JSON and gets an
alignment path for Markdown. Rename suggestions don't apply to Markdown.

### 1.4 Inline markup is protected the way placeholders are

Inside a block, the reader masks what translators must not change as placeholders (the
existing `⟦n⟧` masking in `packages/core/src/tokens.ts`):

- inline code spans (`` `quaso init` ``);
- link and image destinations, and reference labels: the text of `[Download](https://…)`
  is translated, the URL is masked;
- autolinks and bare URLs;
- inline HTML tags (`<br>`, `<kbd>`), and MDX/JSX components if MDX is ever added;
- hard line breaks (two trailing spaces or a backslash);
- footnote references (`[^1]`).

Emphasis markers (`**`, `_`, `~~`) stay visible, because word order changes where emphasis
belongs. They are checked instead (§1.6).

The project's i18next interpolation syntax (`{{…}}`, and extra delimiters such as `{…}`)
**doesn't apply to Markdown files by default.** Prose and heading attributes (`{#id}`) contain
braces. A per-file setting turns the syntax on for templates that are filled in.

### 1.5 Writing keeps the English file's skeleton

The renderer rebuilds the file from the English blocks. Indentation, list markers, quote
markers, blank lines, table pipes, front matter and every literal block stay as they are, and
each translatable block's text is replaced. FMT-3 carries over: rendering the English with
its own text gives the same bytes, and a download with nothing new produces no git diff.

- A translated paragraph is one line. Re-wrapping at the English width would break CJK
  scripts (no spaces) and would cause noisy diffs. Teams that wrap source files should set
  Prettier's `proseWrap: "preserve"` for translation folders.
- Table cells are padded only if the English table was padded.
- An untranslated block is written in English (FMT-2). For Markdown, the existing
  "leave untranslated out" download option means **don't write the file** until every block
  is translated. Leaving paragraphs out of a document gives a broken page.

### 1.6 Checks for Markdown

These run like the current checks (`packages/core/src/checks.ts`), and only on Markdown
entries:

| Check               | Severity | Fails when                                                        |
| ------------------- | -------- | ----------------------------------------------------------------- |
| `placeholder_*`     | error    | a masked code span, URL or tag is missing or extra (reused)       |
| `markup_unbalanced` | error    | emphasis, strikethrough or link brackets don't pair up            |
| `markup_differs`    | warning  | the number of links, emphasised spans or images differs           |
| `block_structure`   | error    | the text starts a new block (`# `, `- `, `> `, a blank line)      |
| `heading_anchor`    | warning  | a heading is linked from the same file as `#slug` (see below)     |
| `identical`         | warning  | as today, ignoring blocks that are only masked tokens and numbers |

**Heading anchors.** Translating `## Installation` changes GitHub's generated anchor from
`#installation` to `#instalación`, so `[see below](#installation)` stops working. The reader
records which headings are link targets in the same file. The renderer then either writes an
explicit anchor (`## Instalación {#installation}`, for renderers that support it) or rewrites
the link fragments to the translated slug. Which of the two is a per-project setting,
defaulting to rewriting fragments, which works on GitHub.

### 1.7 Prompts know they translate a document

- The prompt says that the strings are consecutive blocks of one Markdown document, gives each
  block's heading trail, and says that markup must be kept and nothing may be added before or
  after it.
- File context (`packages/service/src/jobs/file_context.ts`) currently describes a file from
  "the first strings, one JSON object per line". For Markdown, it should send the file's title
  and heading outline instead.
- The LLM's answer schema keeps one value per block, so a model can't merge or split
  paragraphs.

### 1.8 The website shows a document, not a key list

- Display keys as heading trails (§1.3). Group the string list under its headings, and add
  a filter for one section.
- A multi-line editor that grows with its text, and a rendered preview of the block with
  masked tokens shown as chips, in the source and in the translation.
- A read-only "document view" of a language: the file rendered from the current translations,
  with each block coloured by state, and a click opening the block in the editor. A proofreader
  reads a document this way.
- Word counts on the dashboard and the usage page are what matters for Markdown.

## 2. Configuration

```json
{
  "files": [
    { "source": "locales/en/*.json", "translation": "locales/{lang}/{path}" },
    {
      "source": "docs/en/**/*.md",
      "translation": "docs/{lang}/{path}",
      "markdown": { "frontMatter": ["title", "description"], "interpolation": false }
    }
  ]
}
```

The format comes from the extension (`.md`, `.markdown`). Each file already stores its
formatting (`ParsedFile.format`, the JSON indentation and line endings). That record gains a
type (`json` or `markdown`) and the Markdown skeleton. The CLI stops refusing `.md`. The `markdown` options are optional, and the defaults are shown.
MDX is out of scope: JSX can contain arbitrary code, and that needs its own design.

## 3. Import and migration

`quaso import` reads an existing translated Markdown file against the English blocks. When
both have the same block kinds in the same order, the pairs are imported. When they differ
(a translator added a paragraph), the file is refused, and the message names the first block
that differs. Guessing a pairing could put translations under the wrong paragraphs, and
nobody would notice. The Crowdin migration guide gets a Markdown section.

## 4. Tasks, in order

Each task ends with its tests passing. Byte-for-byte round trips are the main test fixture.

1. **Reader** (`packages/core/src/markdown.ts`): a line-based block scanner for CommonMark +
   GFM tables + YAML front matter (string values only). It returns `SourceFile` entries with
   lines, a format record for the renderer, and literals for everything else. It uses no
   packages, like `json.ts`. Test it against a fixture folder of real-world files (a README, a
   patch-notes file, a store description, a doc with tables and nested lists), each asserting
   the exact entries.
2. **Inline masking** (`tokens.ts`): Markdown tokens as placeholders (§1.4), without the
   interpolation syntax unless it is turned on. Write one test per construct.
3. **Renderer**: rebuild a Markdown file from blocks and translations (§1.5). The round-trip
   test (English rendered with English equals the input bytes) runs on every fixture.
4. **Checks** (§1.6), with one test per check and severity.
5. **Upload alignment** (§1.3) in `source_diff.ts`: tests for an inserted paragraph, a
   deleted one, a typo fix (changed, outdated), a rewrite (removed + added) and a moved
   section.
6. **Batching by words** (§1.2): the `batchWords` setting, its admin field, and `batchesOf`
   tests with one oversized block.
7. **Prompts and file context** (§1.7), with prompt snapshot tests.
8. **CLI**: accept `.md`/`.markdown`, the `markdown` config options, download and the "leave
   untranslated out" behaviour (§1.5), and `import` (§3).
9. **Heading anchors** (§1.6), with the setting.
10. **Website**: heading-trail keys and grouping, the growing editor with preview, then the
    document view (§1.8). Add e2e tests for editing a block and for the document view.
11. **Docs**: a "Translate Markdown" page in `docs/`, the config reference, and the
    Crowdin guide. Add a Markdown file to Quaso Quest (its in-game help or patch notes) so the
    demo shows it.

## 5. Open questions

- Should a list item with several paragraphs be one entry (more context, longer) or one per
  paragraph (as proposed)?
- Do we support HTML blocks with translatable text inside (`<details><summary>…`), or keep
  them literal for the first version, as proposed?
- Is 50% similarity the right threshold for keeping an edited block's translation as outdated?
  Measure on the git history of a real docs folder before choosing.
