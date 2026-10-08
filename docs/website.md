# Translating and reviewing on the website

Every Quaso instance has a public website, such as `translate.yourgame.com`. Anyone can read it
without an account: the languages, their progress, every string and its translations, their history
and the project's activity. To take part, you sign in:

- **Volunteers** (the _contributor_ role) suggest translations and corrections, and say "looks good"
  about machine translations. Their changes wait for a review.
- **Managers** edit translations directly, approve or reject suggestions, and run the LLM.
- **Administrators** do all that, and manage the team and the settings.

This guide covers the dashboard, the editor, the states and their colours, the keyboard shortcuts,
and how suggestions are reviewed. The last section is the keyboard audit of the website's
accessibility.

## The dashboard

The home page lists every language the project translates into, with:

- a **progress bar**: blue for proofread words, green (striped) for words translated but not yet
  proofread, grey for the rest;
- **"45% translated • 10% proofread"**, counted in English words;
- the **words left**: the English words of strings nobody has translated yet;
- flags for **outdated** strings, **pending** suggestions and **QA problems**, when there are any.

Search the languages by name or tag, and sort them by name or by progress. Next to the list, the
project's description and its details: the source language, the number of strings, words, files,
languages and members, and when something last happened.

## A language

Open **Sources** next to Dashboard to see the uploaded files in their repository folders.
Each file and folder shows its string and word counts; files also show when an upload last changed
them. Filter by any part of the repository path. Clicking a file opens its editor in the last
language you visited, or the first project language. Without target languages, you can still browse
the sources and their counts.

Click a language to see its **files**, in the same repository folders with progress per file. Type in **Filter files** to
find one, and tick **Hide completed** to leave out files where every string is translated and up to
date, without quality problems. The counts at the top ("3 outdated", "12 untranslated strings"…)
open the editor with that filter.

**Translate all** opens the editor for the whole language; a file opens it for that file.

## The editor

The editor has three panes, like Crowdin's:

1. **Files**: the file tree with progress. "All files" shows every string. On a narrow screen, the
   **Files** button in the editor's bar opens this pane.
2. **Strings**: every string, with its state, its English (placeholders highlighted) and its key
   underneath. Above the list:
   - **Search** by key or text (English or translation);
   - **filters** by state: untranslated, translated (green), proofread (blue), outdated, pending and
     QA problems, each with its count.
3. **Translation**: the selected string, and below it the **History**, **Suggestions**, **Other
   languages**, **Glossary** and **Comments** tabs.

The address bar always holds the file, the filter, the search and the selected string, so you can
share a link to exactly what you see.

### States and colours

| Shape               | Colour | State        | What it means                                                                                                          |
| ------------------- | ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Empty circle        | red    | Untranslated | No translation: the app shows the English.                                                                             |
| Half-filled circle  | green  | Translated   | Translated by the LLM (or imported), **not yet proofread** by a person.                                                |
| Circle with a check | blue   | Proofread    | Written or approved by a person.                                                                                       |
| Clock               |        | Outdated     | The English changed since this was translated. The old translation is still used until someone updates or confirms it. |
| Hourglass           |        | Pending      | Suggestions wait for a review.                                                                                         |
| Warning triangle    |        | QA problems  | The translation fails a quality check.                                                                                 |

**Blue means proofread and green means translated by the LLM: the reverse of Crowdin's colours.** In
Crowdin, green is approved; here, green asks for a person to look at it.

Colour is never the only signal: every state has its own shape and label, and the three colours (a
vermilion red, a bluish-green teal and a strong blue) differ in lightness as well as hue, so they
stay apart for people with red–green colour blindness. Hover over a state, or read the label in the
translation panel, to see it in words.

### Translating a string

The translation panel shows the string's **key**, its file, its state, the **description** the
developers wrote, and its **maximum length** if it has one. Then the **English**:

- **Placeholders** such as `{{count}}` or `{{name}}` are highlighted. The app fills them in, so a
  translation must keep every one of them, unchanged. Click a placeholder chip above the input to
  insert it at the cursor.
- **References** to other strings, such as `$t(common:play)`, are shown as `⟦1⟧`, `⟦2⟧`… with the
  English they refer to (hover over the chip). Keep them where they belong in your language; they
  turn back into the exact reference when you save.

Strings with **plural forms** (such as "1 coin", "5 coins") have one input per form your language
needs, each labelled with the numbers it is used for: Polish has _one_ (1), _few_ (2–4, 22–24,
32–34, …), _many_ (0, 5–21, 25–31, …) and _other_ (1.5). The English of each form is shown above its
input.

As you type, the **quality checks** run: a missing or extra placeholder, a missing plural form, an
empty translation or one longer than the maximum length are **errors**, and saving waits until they
are fixed. A translation identical to the English, or with different numbers, is only a **warning**.
When a string has a maximum length, a counter shows the length in characters as the app counts them.

For right-to-left languages, such as Arabic or Hebrew, the inputs are right to left, and so is the
English when the project's source language is itself right to left.

### What you can do

What the panel offers depends on your role:

| You are                   | You can                                                                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not signed in             | Read everything; "Sign in to suggest a translation".                                                                                                                                                                                               |
| Signed in, without a role | Read everything; an administrator can make you a contributor.                                                                                                                                                                                      |
| Contributor               | **Suggest** a translation or a correction; **Looks good** on a green string.                                                                                                                                                                       |
| Manager or administrator  | **Save** (the translation becomes blue); **Approve** a green string as it is (or confirm an outdated one); **Unapprove** a blue string (it becomes green); **Delete** a translation (the string becomes untranslated); **Translate with the LLM**. |

Managers can also select several strings with their checkboxes (Shift-click, or Shift+Space, selects
a range) to **Approve** the green ones, or to **Translate with the LLM**, in one go. When the server
has no LLM provider, the website says that LLM translation is off. Translations from the LLM arrive
while you work: the editor checks for changes every few seconds after you start a run.

The editor opens in **To do first** order: untranslated strings, outdated translations, then
completed translations. Within each group, strings follow their file and position. Choose **File
order** to browse in source order; the address keeps your choice. Filters apply to either order.

The queue stays in its opening order while you work. Its counter, such as **1 / 23**, uses the
initial number of untranslated or outdated strings and shows **Done** once those entries are
finished. **Previous to do** and **Next to do** skip entries completed since the queue opened.
Reloading or changing a file, filter or order opens a fresh queue.

After you save or suggest, the editor moves to the next string still to do.

If someone else changed the translation while you were editing it, the editor shows their version
and asks: **Use their version**, or **Save mine over it**. If it changed just before you pressed
Approve, Unapprove, Delete or Looks good, the editor shows their version and offers to **Reload**,
or to do the same to their version (**Approve their version**, say): never to put your older text
back.

If your session ends while you work (it expired, or you signed out in another tab), the header shows
it at once and the error offers **Sign in**, which brings you back to the same string. What you
typed stays while the page is open.

Messages after an action appear at the bottom of the window. They go after a few seconds, but not
while the pointer is over them or one of them has focus; error messages stay until you dismiss them.

### Suggestions and review

A contributor's change doesn't replace the translation at once: it waits, **pending**, until a
manager reviews it. The **Suggestions** tab lists the pending suggestions of the string (and those
reviewed in the last 30 days), with the quality checks of each. Managers **Approve** one (the string
becomes blue with that text; the string's other pending suggestions are superseded) or **Reject**
it. The author can **Withdraw** their own pending suggestion.

The **History** tab shows who changed the string and when: the text before and after, and the colour
changes. The **Other languages** tab shows the same string in every other language, with its state;
click a language to open the string there.

## Review queue and your contributions

Managers open **Review queue** to review suggestions across strings. Filter by language, file,
person or status. Each entry shows the source, current translation and proposed change, with a word
diff and current quality checks. **Approve** makes its text blue and supersedes competing proposals.
**Reject** can include a review comment. Select several entries for bulk approval or rejection;
conflicting or invalid entries report their own errors while successful entries finish.

**My contributions** shows your own suggestions and their status, including approved, rejected,
superseded and withdrawn entries. You can withdraw a pending suggestion. A rejected suggestion does
not change the accepted translation. Follow its string link to revise and submit a new suggestion.

## Auto-translate, jobs and usage

Starting a bulk translation closes the dialog. While jobs are queued or running, a small
panel in the bottom-right corner follows their combined progress across pages and reloads.
Polling pauses while the tab is hidden. Follow **View job** to inspect a job's status,
counts and failures; with several jobs, the panel shows their total progress.

When a job finishes, a message shows the translated and failed counts for 10 seconds, or
until dismissed. Cancelled and failed jobs have separate messages. **View failures** opens
the job's failures. Completion refreshes the dashboard, language files and editor counts
without a reload. Both the panel and job cards expose percentages and string counts to
screen readers.

Managers can choose **Auto-translate** from the dashboard, language page or editor. Select languages
and files, review their word counts and the work estimate, and optionally add an instruction or
choose a model for that run. **Untranslated only** also handles outdated work according to the
request; retranslation can include green strings. Blue translations are never overwritten by the
LLM. An outdated blue string receives a proposal for a manager to review.

Files use repository folders with checkboxes. Check a folder to select all files beneath it;
unchecking one file leaves its folder partly checked. **All files** selects or clears the whole
tree. Arrow keys move and expand folders; Space toggles a file or folder. Word counts beside
each node and the per-language breakdown update with the estimate as you change the scope.
The dashboard starts with all languages and files, a language page starts with that language,
and the editor starts with its current language and file or folder. Outdated work is included
by default. The line beneath languages names the configured LLM reference languages and links
to their Settings section. Starting closes the dialog; the job indicator follows its progress.

**Jobs** lists queued, running, paused and finished work. Open progress details for successes,
failures and skipped strings. Cancellation stops remaining work, and failed items can be retried.
Completed translations remain accepted even if another item fails. A provider failure or monthly
budget can pause work; an operator may need to fix the key or budget before it can finish.

**Usage** shows requests and input, output and thinking tokens, by day or month, language and model.
It also shows the configured monthly budget. These are usage counts, not a provider invoice or a
promise about cost. A server without a configured provider explains why translation cannot start.

## Joining and managing the team

A signed-in visitor can choose **Become a volunteer**, select languages and send a short message.
The request waits for an administrator; signing up alone does not allow translation edits. An invite
link can grant its configured role and language access when the account joins.

Administrators use **Team** to approve or reject volunteer requests, assign roles and language
access, remove a member's role, create expiring invite links and revoke invites. Password reset
links are available when a person needs help signing in. Copy a new invite or reset link when shown
and share it privately. Quaso prevents removing the final administrator.

In **Account**, change your name, email or password and link or unlink configured GitHub/Discord
sign-in methods. Sensitive changes may ask for your current password. You cannot remove the last way
to sign in. Deleting your account keeps contributed translations in the project; the confirmation
explains what happens before you proceed.

## Settings and administration

Administrators choose a section in **Settings**:

- **General**: project name, description, logo, links and interpolation delimiters. Match your app's
  placeholder syntax; changing it rechecks translations. **Other placeholders** adds the delimiters
  of placeholders your app fills in itself, such as `{` and `}` for `{name}` beside i18next's
  `{{count}}`: the checks, the editor and the LLM keep them like i18next's.
- **Languages**: add or remove target languages, set instructions and override cardinal or ordinal
  plural categories when the app's runtime needs different rules.
- **Files and length limits**: describe file context and string constraints. Config-defined limits
  are locked here because the next upload owns them.
- **LLM translation**: automatic translation, outdated handling, model, prompt, context languages,
  batch size, neighboring strings, retries and safety. Resetting the prompt changes the draft; save
  to apply it. Unknown prompt placeholders are rejected. Provider credentials stay on the server.
- **API keys**: create named `read` or `upload` keys, copy the secret once, and revoke unused keys.
  Read keys download and inspect status. Upload keys also upload, import and start translation jobs.
- **Backups**: download SQLite or JSON and inspect the last backup. Store exports privately,
  alongside a secure copy of the original instance secret key. See [operations](operations.md) for
  restore drills.

**Admin** shows the release version, storage mode, schema/revision, translator and job health,
recent errors and last backup. It is a diagnostic page for administrators. On Cloudflare, operators
rewind the database with D1 Time Travel; its instructions are in the
[deployment guide](deploy-cloudflare.md#backups-and-recovery).

## Glossary, comments and language requests

Anyone can browse **Glossary** at `/glossary`, search terms and filter by language. A term either
specifies a preferred translation or says **Never translate**. Managers can add, edit and delete
terms for their assigned languages; global terms require an administrator or a manager with access
to all languages. Terms can be case-sensitive and have a note explaining their use.

The editor highlights matching whole-word terms. Its **Glossary** tab shows the applicable
translation or instruction. Enabled glossary context is also included in LLM prompts. Glossary QA
messages are warnings: inspect them, but they do not prevent a save when wording needs to differ.

Use the editor's **Comments** tab to discuss a translation. Contributors and managers can comment in
their permitted languages. A person with a pending volunteer request can also join the discussion
before receiving a contributor role. Check **Problem in the English** to report a source-text issue
shared across languages. This reports the problem; source files still belong in the game's
repository.

Authors may resolve or delete their own comments. Managers can resolve comments in their permitted
languages and source issues; administrators can delete any comment. Managers find unresolved source
reports through **Source issues** in the navigation. The page, **Problems in the English**, is at
`/issues`, with links back to the strings.

The dashboard's **Requested languages** section lists community requests. Signed-in people choose
**Request a language**, enter a valid language tag and an optional message, or **Vote for this
language** on an existing request. Each person gets one vote per language. An enabled human check
must be completed for requests and votes. Administrators review requests in **Settings →
Languages**; **Approve language** adds it to the project through the usual language setup, while
**Reject language** closes the request. Add approved languages to the game's CLI config when they
should be downloaded or included in release gates.

## Keyboard shortcuts

Press <kbd>?</kbd> in the editor (outside a text input) for this list. On a Mac, use
<kbd>⌘</kbd> for <kbd>Ctrl</kbd> and <kbd>⌥</kbd> for <kbd>Alt</kbd>, except for inserting
placeholders (below).

| Keys                                                                                             | What they do                                                                                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd>                                                                 | Save (or suggest), then go to the next string to do. Without a change, just go to the next string to do. |
| <kbd>Alt</kbd>+<kbd>↓</kbd> / <kbd>Alt</kbd>+<kbd>↑</kbd>                                        | The next / the previous string                                                                           |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↓</kbd> / <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd>      | The next / the previous string still to do                                                               |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>                                                    | Copy the English into the input (it replaces the text; undo with <kbd>Ctrl</kbd>+<kbd>Z</kbd>)           |
| <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd>; on a Mac, <kbd>Control</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Insert the first to ninth placeholder or reference (the number is on its chip). See below.               |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd> <kbd>End</kbd> <kbd>Page Up</kbd> <kbd>Page Down</kbd> | Move in the string list                                                                                  |
| <kbd>Enter</kbd>                                                                                 | Open the focused string (in the list)                                                                    |
| <kbd>Space</kbd>                                                                                 | Select the focused string, for bulk actions (managers)                                                   |
| <kbd>?</kbd>                                                                                     | The list of shortcuts                                                                                    |
| <kbd>Esc</kbd>                                                                                   | Close a dialog                                                                                           |

Why these keys for placeholders: on Windows and Linux, browsers keep <kbd>Ctrl</kbd>+digits for
switching tabs, so the editor uses <kbd>Alt</kbd>. On a Mac, <kbd>⌥</kbd>+digits type characters on
most keyboard layouts (<kbd>⌥</kbd>+<kbd>8</kbd> is `{` on a German keyboard,
<kbd>⌥</kbd>+<kbd>2</kbd> is `@` on a Spanish one), and those are exactly the characters
placeholders are made of, so the editor leaves them alone and uses <kbd>Control</kbd>. Clicking a
chip inserts it too. The shortcuts never take keys from the search box.

## Signing in

Sign in with your email address and password (at least 10 characters). Depending on the instance,
you can also sign in with GitHub or Discord, or ask for a sign-in link by email. GitHub or Discord
opens the account with the same email address only once that account's address is verified;
otherwise, sign in with your password first, then link them to your account. An invite link from an
administrator gives your new account its role at once.

Email sign-in links work only after the account's email address has been verified, including for
accounts without a password. If a link says the address is unverified, use password reset to recover
access. A reset replaces the password and signs out every old session. For an unverified address it
also verifies that address and removes any previously linked GitHub or Discord identities; link your
own sign-in methods again after recovery.

If you forgot your password and the instance sends emails, ask for a reset link on the sign-in page.
Otherwise an administrator creates a reset link for you on the Team page. A revoked session cannot
change data, read private account information or link a sign-in method on its next request. Public
project reads may still recognize its signed cookie for up to an hour.

## Themes

The website follows your system's light or dark setting. The theme menu in the header picks light or
dark instead, for this browser.

## Accessibility: the keyboard audit

We aim for WCAG 2.2 AA. This checklist is the keyboard audit of Sprint 7; the browser tests
(`deno task e2e`) check the items marked _(tested)_ on every run.

- [x] A **Skip to content** link is the first thing Tab reaches, on every page.
- [x] Landmarks: a header with the main navigation, the main content, a footer; every page has one
      `h1`, and headings follow in order.
- [x] After every navigation, focus moves to the new page's main heading, so screen readers announce
      it _(tested)_; back and forward restore the scroll position.
- [x] Every input has a label, including the search boxes and each plural form's input ("Plural form
      few, for 2–4, 22–24, …") _(tested)_.
- [x] Focus is always visible: a 2-pixel ring in the focus colour, with at least 3:1 contrast.
- [x] The dashboard: each language is one link; search and sort are a text box and a menu.
- [x] The file tree follows the tree pattern: <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>→</kbd> opens a
      folder, <kbd>←</kbd> closes it or goes to its parent, <kbd>Home</kbd>
      <kbd>End</kbd> jump, <kbd>Enter</kbd> opens a file _(tested)_. One item is in the Tab order.
- [x] The string list: one row is in the Tab order; <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd>
      <kbd>End</kbd> <kbd>Page Up</kbd> <kbd>Page Down</kbd> move between rows, even to rows that
      aren't rendered yet; <kbd>Enter</kbd> opens a string; <kbd>Space</kbd> selects it _(tested)_.
      Rows say their position ("3 of 40") and state in words.
- [x] The state filters are radio buttons: <kbd>←</kbd> <kbd>→</kbd> move between them.
- [x] The editor's shortcuts work from the list and from the inputs, and <kbd>?</kbd> lists them
      _(tested)_.
- [x] Chips, the copy button and every action are buttons, reachable with Tab.
- [x] The tabs follow the tabs pattern: <kbd>←</kbd> <kbd>→</kbd> <kbd>Home</kbd>
      <kbd>End</kbd> switch tabs; Tab enters the panel.
- [x] Dialogs trap focus, close with <kbd>Esc</kbd> and give focus back where it was, or to the
      translation input when what opened them is gone (Delete) _(tested)_.
- [x] Focus never drops to the page: a busy button stays focusable (`aria-disabled`, `aria-busy`),
      and when an action removes its button (Approve, a bulk action, "Show older activity"), focus
      moves to the translation input, the list or the new items _(tested)_.
- [x] Focus is never hidden: scrolling to a focused element keeps it clear of the sticky header, and
      on narrow screens the files overlay closes as soon as focus leaves it _(tested)_.
- [x] Toasts wait while the pointer is over them or they have focus; errors stay until dismissed;
      dismissing a focused toast gives focus back _(tested)_.
- [x] Targets are at least 24×24 pixels, the string checkboxes included _(tested)_.
- [x] The current page in the navigation is bold and underlined, not only a colour _(tested)_.
- [x] Filtering languages, files or strings announces how many match (`role="status"`) _(tested)_.
- [x] The account menu opens with <kbd>Enter</kbd> or <kbd>Space</kbd>, closes with
      <kbd>Esc</kbd>, and returns focus to its button.
- [x] Quality check messages and toasts are announced politely (`aria-live`); the live regions are
      in the page before their first message, so it is announced _(tested)_; errors are announced at
      once (`role="alert"`).
- [x] Contrast: every text colour on every background is at least 4.5:1 in both themes, and icons,
      focus rings and input borders at least 3:1 (a unit test computes every pair from the theme's
      colours, and another checks that no stylesheet fades text with `opacity`).
- [x] Colour blindness: the three state colours differ by more than ΔE 25 under simulated protanopia
      and deuteranopia, and differ in lightness (unit test); shapes and labels carry the states too.
- [x] Right-to-left languages get `dir="rtl"` and `lang` on their inputs and texts, the English
      included when the source language is right to left _(tested)_.
- [x] With reduced motion, nothing animates (the spinner stands still).
- [x] Text zoom to 200% and narrow screens keep everything usable: the panes stack, and the file
      tree moves behind a button.
- [ ] A screen reader pass with NVDA and VoiceOver by a regular user, before release (Sprint 9).
