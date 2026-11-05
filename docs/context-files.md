# Keep context in your repository

Context files keep the context the LLM reads next to your source files, so you change it in a pull
request and `quaso upload` sends it with your strings. You do not need to write each context in
**Settings**. This page covers how to add context files, how they work with edits on the website,
and their limits.

## Add a context file

Write plain text in a file next to your source files. The file's name says what it describes:

| File               | Describes                                                |
| ------------------ | -------------------------------------------------------- |
| `menus.json.quaso` | The source file `menus.json`                             |
| `guide.md.quaso`   | The Markdown document `guide.md`                         |
| `context.quaso`    | Every source file in its folder and the folders under it |

For example, describe what the strings are and where players see them in
`src/locales/en/menus.json.quaso`:

```text
The buttons and labels of the main menu. Each one sits on a single line, so keep them short.
```

Then upload as usual:

```sh
quaso upload
```

The LLM reads each folder's context, starting with the top folder, and then the file's own context. See
[Context, reuse, and meaning checks](concepts.md#context-reuse-and-meaning-checks) for what else it
reads.

## Check an upload first

To see what an upload would change, pass `--dry-run`:

```sh
quaso upload --dry-run
```

The output lists each context the upload would set or clear:

```text
Context from context files (2):
  src/locales/en/menus.json: set
  all files: set
```

## Choose a folder for `context.quaso`

Put `context.quaso` in the folder where a `source` pattern starts, or in a folder under it. Quaso reads
no other `context.quaso` file: the instance knows nothing above that folder, and translation folders
hold no source files. With the pattern `src/locales/en/**/*.json`, the files work as follows:

| File                                 | Describes on the instance |
| ------------------------------------ | ------------------------- |
| `src/locales/en/context.quaso`       | All files                 |
| `src/locales/en/store/context.quaso` | The folder `store`        |
| `src/context.quaso`                  | Nothing: Quaso ignores it |
| `src/locales/de/context.quaso`       | Nothing: Quaso ignores it |

When a `files` entry sets `"folder": "game"`, the first file describes the folder `game` instead of
all files. See [The config file](cli.md#the-config-file) for that setting.

Two context files cannot describe the same folder. When two `files` entries both start at the top of
the instance, give each entry a `folder`, or keep one of the files. Otherwise the upload stops and
names both files.

## Edit a context on the website

You can still edit any context in **Settings → Context**. **A changed file always
wins, and a file that has not changed never replaces an edit.** CI can upload on every push, so this rule
keeps an edit in place until someone changes the file:

| At upload                                      | Result                                         |
| ---------------------------------------------- | ---------------------------------------------- |
| The file is new or changed                     | The file's text becomes the context            |
| The file is the same, the context is edited    | The edit stays                                 |
| The file is removed, the context is edited     | The edit stays, as text written on the website |
| The file is removed, the context is not edited | The context is cleared                         |
| The file is empty                              | The same as no file                            |
| There was never a file                         | Nothing changes                                |

The upload prints a warning when a new or changed file replaces different text, when an edit stays
because the file is the same, and when a removed file leaves an edit in place. These warnings do
not change the exit code.

In **Settings → Context**, search for a folder or file and select it to edit. Filter by
**Repository** to find uploaded context files, **Edited here** to review website changes to them,
or **No own context** to find scopes without written context. Unsaved drafts stay available while
you browse other files or settings sections. Choose **Save context** to apply an edit.

Expand **Context read for this file** (or **Context shared with these files** for a folder) to
inspect saved context in reading order. This preview shows parent guidance followed by the file's
own context or its generated fallback; it does not include unsaved edits.

The editor shows where the text comes from. After an edit, you have two ways to make the file and
the website match:

- To keep the edit, copy the text into the file and upload.
- To drop the edit, choose **Use the file's text**, then **Save context**.

## Use generated context as a default

Generated context is a description the LLM writes for a file when **Include file context** is
selected in **Settings → AI translation**. It only fills a gap, in the following ways:

- The LLM does not generate context for a file that has its own, from a context file or from
  **Settings**, so those files use no tokens for this step.
- Generated context never replaces other text, because Quaso stores it apart from the file's
  context.
- A file with no context of its own still gets generated context when its folder has a context,
  because the folder's context describes the group and not the file.
- The LLM does not generate context for folders.

## Upload part of a project

To upload some files, pass `--file`:

```sh
quaso upload --file menus.json
```

This upload changes the context of `menus.json` only. It leaves every folder's context as it is,
because it does not read all the source files. See
[`quaso upload`](cli.md#quaso-upload) for the other options.

## Limits to know

- **Length.** A context can have at most 20,000 characters. A longer context file stops the upload,
  and the error names the file. Quaso removes the blank space around the text before it counts.
- **Existing translations.** A changed context does not start a translation job. The LLM reads the
  new context the next time it translates a string from that file.
- **One direction.** Uploads read context files, and nothing writes to them. An edit on the website
  reaches your repository only when you copy it there.
- **API keys.** An upload with an API key that has the `upload` scope can change contexts through
  context files, even though that scope cannot edit them in **Settings**. Review context files as you
  review code.
- **Versions.** A CLI with this feature cannot upload to an earlier instance, which refuses the
  request. Update the instance first. An earlier CLI still uploads to a later instance, and leaves
  every context as it is.

## Next steps

- **[`quaso upload`](cli.md#quaso-upload).** Every option of the command that sends context files.
- **[The config file](cli.md#the-config-file).** Set the `folder` of a `files` entry.
- **[Add Quaso to your game](add-to-your-game.md).** Run uploads as part of your build.
