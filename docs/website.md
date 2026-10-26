# Translating and reviewing on the website

Use the Quaso website to suggest translations, review changes, and manage a translation team.
Anyone can browse the project's languages, source strings, translations, history, and activity
without an account. To change anything, sign in and get the access your task needs.

A **source string** is a piece of text from the game. Its **source language** can be any language;
examples on this page use English. See [how translation works](concepts.md) for the full workflow
and the difference between a translation and a suggestion.

## Signing in

Sign in with your email address and password. New passwords need at least 10 characters. If the
instance offers them, you can also use GitHub, Discord, or an email sign-in link.

Creating an account does not grant permission to translate. Choose **Become a volunteer**, select
languages, and send a message to the administrators. Wait for approval, or use an invite link that
grants a role and language access.

These roles control what you can do:

| Role                      | Access                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Signed in, without a role | Browse the project and request volunteer access or a new language. A pending volunteer request also allows comments.        |
| Contributor               | Suggest translations and corrections, or choose **Looks good** on a green translation. A manager reviews these suggestions. |
| Manager                   | Save translations directly, review suggestions, manage glossary terms, and start automatic translation.                     |
| Administrator             | Do the manager's tasks, manage the team, and change settings.                                                               |

Contributors and managers can be limited to specific languages. An administrator can change these
limits. Signing in alone does not make a language editable. Every signed-in person can create and
revoke their own API keys in **Account**; a key never grants more access than its creator has.

### Recover access

If the instance sends email, use the password-reset link on the sign-in page. Otherwise, ask an
administrator for a reset link from **Team**. A reset changes the password and signs out old sessions.

Email sign-in links require a verified email address. GitHub and Discord can join an existing
account with a matching email only if that account's address is verified. Otherwise, sign in with
your password and link the method in **Account**. If you cannot access an unverified account, use
password reset. Recovery verifies the address and removes linked GitHub and Discord identities;
link your own methods again afterward.

## The dashboard

The home page, **Overview**, lists the project's target languages. Search by language name or tag, then sort by
name or progress. Each language shows:

- A progress bar: solid blue for proofread words, a green checkerboard for translated words
  awaiting review, and sparse dots for untranslated words.
- Translated and proofread percentages, measured in **source words**. Translated progress includes
  both green and blue translations.
- The number of source words without a translation.
- Counts for outdated translations, pending suggestions, and quality problems when present.

Project details include the source language, description, file and string counts, and recent
activity. Select a language name to explore its files, or choose **Open editor** to go directly
to its translation queue. The desktop navigation groups pages under **Project**, **Contribute**,
and **Manage**. On small screens and in the editor, use **Menu** to reach those pages.

## A language

The language page lists files in their repository folders, with progress for each file. Use
**Filter files** to find a path. Select **Hide completed** to hide files whose strings are translated,
up to date, and free of quality problems. Completion here does not require every translation to
be proofread.

Open a file to translate it, or choose **Translate all** to work across the language. Summary counts,
such as untranslated or outdated strings, open the editor with that filter.

To browse the source files first, open **Sources** in the navigation. It shows string and word
counts and when each file changed. Opening a file uses your last visited target language, or the
first target language. You can browse sources even before the project has target languages.

## The editor

The editor has three panes:

1. **Files** lists files and folders. **All files** includes every source file. On a narrow screen,
   use the file selector above the string list, labeled **All files** or the current file name,
   to open this pane.
2. **Strings** lists source text, keys, and translation states. Search by key, source text, or
   translation. Open the **All strings** filter to choose untranslated, translated, proofread,
   outdated, pending, or quality problems.
3. **Translation** shows the selected string and the **History**, **Suggestions**, **Other languages**,
   **Glossary**, and **Comments** tabs.

The page address records the selected string, file, filter, search, and sort order. Copy it to share
that view with someone else.

### States and colours

| Shape              | Colour | State        | Meaning                                                                                                            |
| ------------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| Empty square       | Red    | Untranslated | No accepted translation exists. Downloads use the source text unless configured to leave missing translations out. |
| Half-filled square | Green  | Translated   | A translation exists but is not marked as proofread. It can come from the LLM, an import, or **Unapprove**.        |
| Checked square     | Blue   | Proofread    | A person saved or approved the translation, or it was imported as proofread.                                       |
| Clock              |        | Outdated     | The source changed. Downloads keep the old translation unless configured to omit outdated text.                    |
| Hourglass          |        | Pending      | One or more suggestions await review.                                                                              |
| Warning triangle   |        | QA problems  | The translation has a quality-check error.                                                                         |

**QA** means quality assurance. The icons and text labels identify states as well as colour.
Outdated, pending, and quality problems are flags that can appear alongside a translation state.
Blue and green record review status; they do not guarantee that a translation is correct. The
**QA problems** filter also includes stored duplicate, consistency, and meaning warnings, even when
they do not block a save.

### Translating a string

You need contributor, manager, or administrator access for the language.

1. Open a language and a file, then select a string.
2. Read the source text, description, maximum length, and relevant glossary terms.
3. Enter the translation. For a plural string, fill in each form shown by the editor. Each input
   gives example numbers and the matching source text, or the source's `other` form.
4. Fix any errors shown below the inputs. Review warnings too; they do not block saving.
5. Choose **Suggest** as a contributor, or **Save** as a manager or administrator.
6. Check **Suggestions** for your pending proposal, or **History** for a saved translation. The
   editor moves to the next string still to do after submission.

A **placeholder**, such as `{{count}}`, marks text that the game fills in. Keep its spelling and
brackets unchanged. Select a chip above the input to insert it. Some projects allow specific
placeholders to be left out in selected languages; the quality checks use those settings.

References to other strings, such as `$t(common:play)`, normally appear as `⟦1⟧`, `⟦2⟧`, and so on.
Hover over a reference chip to see its source text. Keep each reference where it belongs in your
translation. Saving restores the original reference syntax. If this numbered notation would
conflict with the string's text, the editor keeps the original references visible.

In a project that uses ICU MessageFormat, placeholders look like `{name}` or `#`, and a string can
hold blocks such as `{n, plural, one {# coin} other {# coins}}`. The source shows such a string as
a tree: each block's cases on lines of their own, labelled `one`, `other`, `female` and so on.
Such a string is translated case by case: one field per case, labelled `female › one` and so on,
with the case's English above it, and the syntax around the fields kept for you. A plural block
gets one case per plural category of your language; the line above the fields lists them with
example numbers. Type braces and apostrophes as they are: Quaso quotes them as ICU needs. Use Tab
to move between the fields. **Edit as text** shows the whole message as ICU instead; a translation
whose blocks or cases differ from the English's opens that way, with a note. **Preview in each
case**, under the input, shows your translation in every case, with an example number for `#`, and
says where the text stops being valid ICU. In the text input, **Copy the English** starts you off
with your language's cases; in the fields, it copies the English of the field you are in. To write
a literal `{` or `'` in the text input, refer to
[braces and apostrophes](file-formats.md#braces-and-apostrophes).

A string can also vary by a value the English doesn't show, such as the gender of the person who
wrote a post: under the source, **Can vary by** names it, with its cases and what it means. Where
your language makes words agree with it, select the text that changes and press **Vary by
authorGender** (the argument's name): the selection goes into every case of a select block, and you
adjust each case. Where your language needs no agreement, write one text. See
[arguments the English doesn't show](file-formats.md#arguments-the-english-doesnt-show).

The editor checks for missing or extra placeholders and references, missing plural forms, empty
translations, and length limits as you type. A missing placeholder or reference turns its chip red.
For JSON strings, leading and trailing whitespace and the number of line breaks must match the
source. A single-line source keeps a single-line input: Enter does not add a line break, while
Ctrl/⌘+Enter still saves. The source marks spaces at its edges with `·` and line breaks with `↵`.

Errors block **Save** and **Suggest**. Warnings include text identical to the source, different
numbers, changed HTML or Trans tags, repeated spaces, and differences in ending punctuation.
A translation reused for different source text in the same file can also produce a warning.
Length limits count visible characters, including placeholder text, rather than bytes.
See [file formats and quality checks](file-formats.md) for the full rules and exceptions.

A Markdown **document** is translated as one text. Its file name replaces the key, and the editor
shows the full source and a paragraph counter. Three tabs show the translation:

- **Whole file**: one input for the whole document.
- **Side by side**: each English paragraph beside an input for its translation. It needs the
  translation to have as many paragraphs as the English, or to be empty.
- **Preview**: the translation rendered, with headings, lists, links, tables and code. Images show
  their alt text.

Keep the number of paragraphs (blocks separated by blank lines), the kind of each block,
placeholders, code, link URLs and front matter keys. Line breaks within paragraphs can change. The
checks ignore final whitespace when comparing documents. For an outdated document, the notice shows
only the paragraphs whose English changed. The review queue shows only the paragraphs an LLM
proposal changes.

For a language written from right to left, the input uses that direction. Source text also uses the
source language's direction.

### What you can do

For an outdated translation, a notice shows how the source changed and explains whether to update
the translation, approve it as still valid, or review an LLM proposal.

Managers and administrators have these additional actions within their language access:

- **Approve** marks a green translation as proofread, or confirms that an outdated translation
  still fits the source.
- **Unapprove** changes a blue translation to green.
- **Delete** removes the accepted translation after confirmation. The string becomes untranslated.
- **Translate with the LLM** requests a machine translation when a provider is available. An
  up-to-date blue translation does not offer this action. An outdated blue translation receives
  a proposal for review.

**LLM** means large language model, the service used for automatic translation. Managers can select
several strings with checkboxes and approve green translations or request LLM translations in a
batch. Shift-click or Shift+Space selects a range.

The editor starts in **To do first** order: untranslated strings, outdated translations, then the
remaining strings. Within each group, it follows file and source order. Choose **File order** for
source order throughout.

The queue keeps its opening order as you work. Its counter uses the initial untranslated and
outdated entries, then shows **Done** when those entries are complete. **Previous to do** and
**Next to do** skip completed entries. Reloading or changing the file, filter, or order starts a
new queue. A suggestion alone does not turn an untranslated string into an accepted translation.

If someone changes a translation before you save, compare their version with yours. Choose
**Use their version** or **Save mine over it**. Conflicts during other actions offer **Reload** or
an action on the newer version, such as **Approve their version**.

If your session expires, the next failed request offers **Sign in** and a return to the same string.
Your current draft stays while the page remains open; copy it before closing or reloading the page.
Action messages pause while hovered or focused. Errors stay until dismissed.

### Suggestions and review

A suggestion does not replace the current translation until a manager approves it. The
**Suggestions** tab shows pending suggestions and those reviewed in the last 30 days. Managers can
**Approve** or **Reject** them. Authors can **Withdraw** their own pending suggestions.

Approval makes the suggested text blue and closes competing pending suggestions as superseded.
The **History** tab shows accepted changes, their authors, and state changes. **Other languages**
shows the same string's translations and links to open them.

### LLM suggestions

Managers and administrators can enable **LLM suggestions** above the input when a provider is
available. The browser remembers this choice. After you stay on an untranslated or outdated string
for half a second, the editor asks for drafts for that string and the next seven to do, four to a
request. It keeps six drafts ready or on their way ahead of you as you work. Requests use the project's instructions, context, and quality
checks, and count toward usage and the monthly token budget.

A draft appears below each input. Click it, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>,
to replace the focused input. Use <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo. Nothing is accepted until you
choose **Save**. These local drafts are separate from the pending proposals in **Suggestions**.

Returning to a string in the same page session reuses its draft. When the server is busy or can't
be reached, the editor sends the request again up to three times, after 1, 2 and 4 seconds. A
failed response leaves you free to type your own text; after half a minute, revisiting that string
can request it again. For many accepted machine translations at once, select strings
and choose **Translate with the LLM** instead.

In **Settings → AI translation**, administrators can choose **Model for editor suggestions**.
**The project model** uses the normal model again. The suggestion request asks for as little model
thinking as the provider supports; response time still depends on the model and provider.

## Review queue and your contributions

Managers use **Review queue** to work across strings. Filter by language, file, author, or status.
Compare the source, current translation, proposed text, and current quality checks before approving.
A rejection can include a comment. Select several entries to approve or reject them together;
entries with conflicts or errors fail separately from successful entries.

**My contributions** lists your own suggestions and their status. Withdraw a pending suggestion
there, or follow a rejected suggestion's string link to revise and submit it again. Rejection does
not change the accepted translation.

## Auto-translate, jobs and usage

Managers and administrators can start automatic translation for their permitted languages:

1. Choose **Auto-translate** on **Overview**, a language page, or the editor.
2. Select languages and files. Folder checkboxes select the files beneath them. The starting scope
   follows the page you opened: all languages on **Overview**, one language on its page, or the
   editor's current language and file or folder.
3. Choose **Untranslated only** or **Also re-translate green translations**. **Update outdated
   translations** is selected by default. It rewrites outdated green translations and proposes
   updates for outdated blue translations.
4. Review the estimated strings, source words, requests, and tokens. If needed, enter an instruction
   or choose a model for this run. The estimate separates new translations, repeated translations,
   updates, and proposals. The dialog also lists configured reference languages.
5. Choose **Start translation**, then follow **View job** to check progress and failures.

Blue translations are never overwritten by the LLM. Outdated blue translations receive suggestions
for review. Starting a job closes the dialog. A progress panel follows active jobs across pages
and reloads; it pauses checks while the browser tab is hidden.

**Jobs** lists queued, running, paused, and finished work. Open a job for counts and failures. Cancel
a job to stop remaining work, or retry failed items. Work already saved stays saved if another item
fails or the job is cancelled. Provider errors or the monthly budget can pause a job; an
administrator might need to change the key or budget before it can continue.

**Usage** shows requests and input, output, and thinking tokens by day or month, language, and model.
A token is a unit of text processed by the provider. These counts and the monthly token budget are
not a cost estimate or an invoice. If no provider is configured, ask an administrator to set one up.

### Reuse matching translations

Administrators can enable **Reuse translations of identical source strings** in **Settings →
AI translation**. This translation memory is off by default. It copies a current translation from
the same language when the source text, string kind, and plural structure match. A copied value
becomes green; a proofread original stays blue. When several matches exist, proofread matches are
preferred. History records the source key, and job results count reused translations separately.
A batch filled entirely from memory makes no translation or file-context request to the provider.

The editor links other keys with the same source. Different translations of identical source text
can produce consistency warnings. These warnings ask for review; they do not prove that context
requires the same wording everywhere.

### Check meaning and source clarity

Managers can choose **Check meaning** for a string, file, language, or pending suggestion. Review
the model's explanation in **Jobs** and the quality warnings. A meaning check does not change the
accepted text, review state, or translation revision.

Automatic checks are off by default. In **Settings → AI translation**, administrators choose whether
to check on save or approval, which review states to check, the model, and whether checks count
against the monthly token budget. Usage records every request, even when it does not count against
that budget. Changed source text, translation text, or context makes an old finding invalid;
results based on a version changed during the request are not applied.

Translation jobs can also report that a source has more than one meaning. The editor shows these
notes above the source. **Sources** marks current ambiguous text without context as **Needs a
description**. Ask a developer to add a description in the source repository and upload it again to explain the
intended meaning. See [file formats](file-formats.md) for repository descriptions.

When meaning checks are enabled, a translation job can report a concern about a reference
translation shown to the model. This adds a warning and job note without a separate comparison
request. The reference must still match the value shown to the model.

## Joining and managing the team

Administrators use **Team** to approve volunteer requests, assign roles and language access, remove
roles, and create or revoke invite links. Copy new invite or password-reset links when shown and
share them privately. Quaso prevents removal of the final administrator.

Use **Account** to change your name, email, or password, and link or unlink available GitHub and
Discord sign-in methods. If your account has a password, changing its email or password requires
that password. You cannot unlink your last way to sign in. Deleting your account removes its
personal details and pending suggestions; accepted translations remain, attributed to **Deleted user**.

In **Account → API keys**, name a key, choose its scope, and select **Create API key**. Copy the
secret when shown; use **Revoke key** when it is no longer needed. A key is limited by both its
scope and its creator's current role and languages. A `read` scope allows reads and downloads only
if the creator can do them. An `upload` scope can also allow uploads, imports, translation jobs, and
usage reads. It does not grant those rights to a role that lacks them.

A person without a role or a contributor can use a key for public reads, but not downloads. A
manager's upload key can start translation jobs in their assigned languages but cannot upload or
download files. Use an administrator-created key for the full CLI upload and download workflow.
Deleting an account disables its keys; role and language changes affect existing keys too.

## Settings and administration

Administrators select a section in **Settings**:

| Section               | What it controls                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project details       | Project name, description, logo, and links.                                                                                                                      |
| Placeholders          | Default syntax, additional formats, and language exceptions. Match the game's syntax; changes trigger new quality checks.                                        |
| Languages             | Target languages, language instructions, and plural-category overrides.                                                                                          |
| Files & length limits | Folder and file context and maximum string lengths. Limits owned by the CLI configuration must be changed there and uploaded.                                    |
| Language requests     | Community requests to add languages.                                                                                                                             |
| AI translation        | Gemini key, automatic translation, models, reference languages, translation memory, meaning checks, and token budget. Save a new key before **Test Gemini key**. |
| Email delivery        | Email provider, sender, credentials, and a test message.                                                                                                         |
| API keys              | All users' keys and their creators. Create keys and revoke unused ones; scopes and creator permissions both apply.                                               |
| Backups               | Download SQLite or JSON backups and check backup status. Keep copies private: they contain account data.                                                         |
| History & retention   | How long to keep past published file versions and backups.                                                                                                       |

Use the Settings sidebar, or **Settings section** on a narrow screen. In **Placeholders**,
**Additional formats** adds syntax such as `{name}` alongside `{{count}}`. **Language exceptions**
allows specific placeholders to be absent in selected languages. Explain these choices to
translators, then choose **Save placeholder rules**.

In **AI translation**, choose models from the provider's list. If that list is unavailable, the
control accepts a model name. The automatic-upload options separately control new translations,
updates to outdated green translations, and proposals for outdated proofread translations.
**Auto-translate** asks which outdated work to handle for each run. Expand **Advanced: prompt and
performance** for the prompt, batch size, nearby-string context, retries, and safety settings.

Saved provider keys are not returned in full by the website. Resetting the prompt changes its draft;
choose **Save AI settings** to apply it. Unknown prompt placeholders are rejected.

**Instance** shows the release, storage mode, database version and revision, translator and job health,
recent errors, and backup status. See [operations](operations.md) for backup and recovery procedures,
and [Cloudflare recovery](deploy-cloudflare.md#backups-and-recovery) for D1 Time Travel.

## Glossary, comments and language requests

Anyone can browse **Glossary** and search terms by language. A term gives a preferred translation or
says **Never translate**. Managers can maintain terms for their languages. Global terms require an
administrator or a manager with access to all languages. Matching terms appear in the editor;
glossary quality checks produce warnings, and enabled glossary context is included in LLM prompts.

### Build a glossary and language style guide

On **Glossary**, managers can choose **Suggest glossary terms**. The job finds repeated domain
terms in source files and compares existing translations. Review the examples and counts in the
report. Edit the proposed translation, accept it as a glossary entry, or dismiss it. By default,
a candidate must appear in at least three strings across two files.

Existing glossary terms also appear in consistency reports. After agreeing a term, use
**Re-translate N green strings with the glossary** to update affected green translations.
Proofread translations stay unchanged.

On a language page, administrators can choose **Draft style guide**. The model uses current
proofread translations to propose language instructions about tone, regional words, punctuation,
and placeholder spacing. Review and edit the draft, then choose **Save language instructions**.
Generating the draft alone changes no instructions or translations. **Jobs** lists terminology
reports, style-guide drafts, and meaning checks alongside translation jobs.

### Discuss source text and translations

Use **Comments** to discuss a string. Contributors and managers can comment within their language
access; a pending volunteer can also comment. **Problem in the English** reports a source issue
shared across languages, even if the source language is not English. Developers fix the source in
the game's repository and upload it again.

Authors can resolve or delete their own comments. Managers can resolve comments in their languages
and source issues; administrators can delete any comment. Managers open **Source issues** to find
unresolved reports on the **Problems in the English** page.

If language requests are enabled, signed-in users can choose **Request a language** from **Overview** or **Vote for this language**
on a request. Each person gets one vote per language. Complete a human check if the instance asks
for one. Administrators review these in **Settings → Language requests**. **Approve language** adds the language; **Reject language** closes the request. Add approved languages to the game's CLI
configuration too, so downloads include them.

## Keyboard shortcuts

Press <kbd>?</kbd> in the editor, outside a text input, to open the shortcut list. On a Mac, use
<kbd>⌘</kbd> for <kbd>Ctrl</kbd> and <kbd>⌥</kbd> for <kbd>Alt</kbd>, except when inserting placeholders.

| Keys                                                                                                       | Action                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd>                                                                           | Save or suggest, then move to the next string to do. With no change, move to the next string to do. |
| <kbd>Alt</kbd>+<kbd>↓</kbd> / <kbd>Alt</kbd>+<kbd>↑</kbd>                                                  | Open the next or previous string.                                                                   |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↓</kbd> / <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd>                | Open the next or previous string still to do.                                                       |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>                                                              | Replace the input with the source text. Use <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo.                   |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>                                                          | Replace the focused input with its LLM suggestion. Use <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo.        |
| <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd>; on a Mac, <kbd>Control</kbd>+<kbd>1</kbd>…<kbd>9</kbd>           | Insert the numbered placeholder or reference chip.                                                  |
| <kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>Home</kbd> / <kbd>End</kbd> / <kbd>Page Up</kbd> / <kbd>Page Down</kbd> | Move through the string list.                                                                       |
| <kbd>Enter</kbd>                                                                                           | Open the focused string.                                                                            |
| <kbd>Space</kbd>                                                                                           | Select the focused string for a manager's batch action.                                             |
| <kbd>Esc</kbd>                                                                                             | Close a dialog.                                                                                     |

Clicking a chip also inserts it. Placeholder shortcuts use <kbd>Control</kbd> on a Mac because
<kbd>⌥</kbd> with a digit can type characters needed in translations. The shortcuts leave search
inputs to their normal keyboard behavior.

## Themes

The website follows your system's light or dark setting. Use the theme menu in the header to choose
**System theme**, **Light theme**, or **Dark theme** for this browser.

## Accessibility: the keyboard audit

Use **Skip to content** to reach the main page. File trees use arrow keys to move and expand folders;
the string list uses the keys above. States include shapes and text, and inputs use the language's
writing direction. The interface also includes styles for reduced-motion preferences.

These features and automated checks are not a claim of full accessibility conformance. The
[accessibility review procedure](contributing/testing.md#accessibility-review) covers keyboard,
contrast, zoom, and screen-reader checks for contributors.
