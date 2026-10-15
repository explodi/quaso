# Bring your Crowdin AI prompt

Adapt your existing AI translation prompt to Quaso's inputs and output format. First follow
[Migrate from Crowdin](migrate-from-crowdin.md) to move files and translations. You need an
administrator account to change the prompt in **Settings → AI translation**.

## Prompt and context mapping

Use Quaso's default prompt as a starting point, then add your project's tone and language rules.
Quaso checks its own placeholder names: each name inserts context when the prompt is built. The following maps the concepts used in Crowdin's
prompt/context controls to Quaso; available Crowdin labels and placeholders vary by its prompt
version.

| Existing prompt or context              | Quaso placeholder / setting                       | What to check                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source / target language                | `%sourceLanguage%`, `%targetLanguage%`            | Resolved to the selected languages                                                                                                                |
| Required plural forms                   | `%pluralForms%`                                   | Quaso supplies the target language's plural categories and example numbers                                                                        |
| Project description                     | `%projectName%`, `%projectDescription%`           | Copy the description in project settings                                                                                                          |
| Translation instructions                | `%projectInstructions%`, `%languageInstructions%` | Project rules and per-language tone                                                                                                               |
| File name and AI-generated file context | `%fileName%`, `%fileContext%`                     | Copy known context or enable generated context                                                                                                    |
| Translations in other languages         | `%otherLanguages%`                                | Select context languages explicitly                                                                                                               |
| Translation memory context              | `%identicalStrings%`                              | Quaso includes current green and blue translations of identical source text; proofread matches come first. No external translation-memory import. |
| Glossary context                        | `%glossary%`                                      | Enter terms in Quaso separately; imports do not carry them                                                                                        |
| Neighboring strings                     | `%neighbours%`                                    | Set the neighbor count                                                                                                                            |
| Text to translate                       | `%strings%`                                       | Required; includes keys, IDs, descriptions, plural forms, length limits, protected references, and document markers                               |
| Run-specific instruction                | `%customInstruction%`                             | Added for one translation run                                                                                                                     |
| Screenshots                             | No prompt placeholder                             | Not migrated or sent as image context                                                                                                             |

Prompt context is separate from automatic reuse. The optional **Reuse translations of identical source strings**
setting copies a current matching translation as green after quality checks; it is off by default.
It does not import Crowdin translation memory.

Keep Quaso's JSON output rules and its instructions for protected references such as `⟦1⟧`.
These markers preserve references to other strings while the model translates the surrounding text. A paragraph with an empty placeholder
is omitted, and lines beginning `%%` are notes. `---STRINGS---` separates stable instructions from
per-batch content. Use the prompt preview to check a real string and plural before saving. Review the model, batch size, retry count, safety setting, and context choices. Then translate one
file into one language. Ask a fluent speaker to check the result, including tone, placeholders, and
plural forms, before enabling automatic translation. Continue with
[the translation workflow](workflow.md) to review and download the result.
