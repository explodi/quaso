# Translate without an instance

The `quaso translate` command can translate a small project by itself: it reads your source
files, asks a large language model (LLM) with your own API key, and writes the translation files. You
do not host anything, and the CLI runs the same translation code as an instance. This page covers
how to set it up, where the settings and context live, and the limits.

Use an instance when people proofread translations, or when a team shares a glossary and a
history. See [Quick start](README.md) for that path.

## Translate a project

You need Node.js 22.13 or later and an API key for Google Gemini or Anthropic Claude. Install the
CLI and write the config file in your repository:

```sh
npm install --save-dev @quaso-i18n/cli@main
npx quaso init --languages de,fr,ja
```

Check the `files` entry in the `quaso.config.json` file: it says where your source files are and
where translations go. Then set the key and translate:

```sh
export GEMINI_API_KEY='your Gemini API key'
npx quaso translate
```

The command prints its progress, then the files it wrote:

```text
Translating de, fr, ja with gemini-flash-latest, without an instance…
Translation job 1 is queued (84 strings).
Translating: 50 of 84 (59%).
Translation job 1 done: 84 of 84.
  created  src/locales/de/common.json
  created  src/locales/fr/common.json
  created  src/locales/ja/common.json
84 translated (48,210 tokens).
Wrote 3 files, 0 unchanged.
```

Commit the translation files and the `quaso.lock.json` file. To use Claude, set the
`ANTHROPIC_API_KEY` variable instead.

## Translate after a change

Run the same command again after you change your source files:

```sh
npx quaso translate
```

The command translates only the strings that are new or whose source text changed, so a second run
with no changes asks the LLM for nothing. **The `quaso.lock.json` file makes this work.** For
each translation, the file records the source text that the translation was made for. Keep the
file in Git with the translation files, and do not edit it.

The command reads your translation files before it translates, and it follows these rules:

| In the translation file                              | Result           |
| ---------------------------------------------------- | ---------------- |
| A translation of the current source text             | Kept as it is    |
| A translation you wrote or changed by hand           | Kept as it is    |
| A translation of source text that has changed        | Translated again |
| The source text, where a translation never succeeded | Translated       |
| No value                                             | Translated       |

To translate a string again, remove its value from the translation file. To translate every
string again, pass the `--retranslate` option.

## Keep settings in the config file

The `settings` field of the `quaso.config.json` file holds the project settings that an instance
keeps in **Settings**. Add the following field to tell the LLM about your game:

```json
"settings": {
  "name": "Quaso Quest",
  "description": "A cozy game about a cat who runs a bakery.",
  "llm": {
    "model": "gemini-flash-latest",
    "projectInstructions": "Keep the tone warm and playful."
  },
  "languages": {
    "de": { "instructions": "Address the player with du." }
  }
}
```

See [The `settings` field](cli.md#the-settings-field) for every setting. Without a `model`
setting, the command uses `gemini-flash-latest`, or `claude-haiku-5-5` when only the
`ANTHROPIC_API_KEY` variable is set.

## Describe files and folders

Context files tell the LLM what a file or a folder holds. Write plain text in a `context.quaso` file
for a folder, or in a file such as `menus.json.quaso` for the source file `menus.json`:

```text
The buttons and labels of the main menu. Each one sits on a single line, so keep them short.
```

The command reads these files on every run. See
[Keep context in your repository](context-files.md#add-a-context-file) for where to put them.

## Check a run first

To see how much a run would translate, pass the `--dry-run` option:

```sh
npx quaso translate --dry-run
```

The command counts the strings and words, and estimates the tokens. It asks the LLM for nothing and
writes no files.

## Move to an instance later

The same config file, context files and translation files work with an instance. Set the
`QUASO_HOSTNAME` and `QUASO_API_KEY` variables, then upload your source files and import your
translations:

```sh
npx quaso upload
npx quaso import --as green
```

The upload stores the settings and the context files on the instance. With the `QUASO_HOSTNAME`
variable set, the `quaso translate` command starts a job on the instance. To translate by itself
again, pass the `--local` option.

## Limits to know

- **One command.** Only the `quaso translate` command works without an instance. The `upload`,
  `download`, `status` and `import` commands need one.
- **No proofreading.** Every translation is green: the LLM wrote it and no person checked it.
  The command never changes a value that you wrote in a translation file.
- **No glossary.** A glossary lives on an instance. Put fixed terms in the `projectInstructions`
  setting instead.
- **Less context between strings.** An instance shows the LLM proofread translations of nearby and
  identical strings. Without an instance, no translation is proofread, so the LLM does not see them.
- **Generated context costs tokens.** For a file with no context file, the LLM writes a short
  description first, on each run that translates strings of that file. A context file saves those
  tokens.
- **Failed strings.** A string that fails the quality checks stays untranslated, and the command
  ends with exit code 6. The translation file then holds the source text for that string, unless
  the `untranslated` field is `"omit"`. The next run tries the string again.

## Next steps

- **[`quaso translate`](cli.md#quaso-translate).** Every option of the command.
- **[The config file](cli.md#the-config-file).** Every field, with the `settings` field.
- **[Keep context in your repository](context-files.md).** Where context files go and what they describe.
- **[Quick start](README.md).** Host an instance when your team wants to proofread.
