# Move from Crowdin

Follow [Migrate from Crowdin](migrate-from-crowdin.md) for layout conversion and two-pass imports,
then [From your repository to every language](workflow.md) for the ongoing workflow.

## Prompt and context mapping

Copy the intent of the AI prompt into **Settings → LLM translation**, not just its text. Quaso
validates its own placeholder names. The following maps the concepts used in Crowdin's
prompt/context controls to Quaso; available Crowdin labels and placeholders vary by its prompt
version.

| Existing prompt or context              | Quaso placeholder / setting                       | What to check                                                                      |
| --------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Source / target language                | `%sourceLanguage%`, `%targetLanguage%`            | Resolved to the selected languages                                                 |
| Required plural forms                   | `%pluralForms%`                                   | Quaso supplies CLDR categories and example numbers                                 |
| Project description                     | `%projectName%`, `%projectDescription%`           | Copy the description in project settings                                           |
| Translation instructions                | `%projectInstructions%`, `%languageInstructions%` | Project rules and per-language tone                                                |
| File name and AI-generated file context | `%fileName%`, `%fileContext%`                     | Copy known context or enable generated context                                     |
| Translations in other languages         | `%otherLanguages%`                                | Select context languages explicitly                                                |
| Translation memory context              | `%identicalStrings%`                              | Quaso uses identical proofread source text in this instance; no external TM import |
| Glossary context                        | `%glossary%`                                      | Enter terms in Quaso separately; imports do not carry them                         |
| Neighboring strings                     | `%neighbours%`                                    | Set the neighbor count                                                             |
| Text to translate                       | `%strings%`                                       | Required; includes keys, IDs, forms, limits and locked tokens                      |
| Run-specific instruction                | `%customInstruction%`                             | Added for one translation run                                                      |
| Screenshots                             | No prompt placeholder                             | Not migrated or sent as image context                                              |

Keep Quaso's JSON output rules and locked-token instructions. A paragraph with an empty placeholder
is omitted, and lines beginning `%%` are notes. `---STRINGS---` separates stable instructions from
per-batch content. Use the prompt preview to inspect a real string and plural before saving. Copy
the model, batching, retries, safety and context choices where applicable; then compare a small real
run with a native speaker before enabling automatic translation.
