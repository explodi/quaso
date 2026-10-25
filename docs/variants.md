# Gender, plurals and other variants

A string often has more than one form: it counts something, it talks about a person whose gender
changes the words, the app picks one of several ways to say it, or the app joins it with other
paragraphs. Each kind of variation has one right tool. Following the rules on this page keeps
every language grammatical, lets the LLM translate right the first time, and lets the checks catch
what is wrong.

Plural, select and declared arguments need [ICU MessageFormat](file-formats.md#icu-messageformat)
turned on. Alternatives and fragments work in both message formats.

## Choose the tool

| What varies                                           | Example                                   | Use                                                           | Who writes the cases                                  |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| A number                                              | 1 coin, 3 coins                           | A `plural` block in the English                               | The English; each language gets its own plural cases  |
| A rank                                                | 1st, 2nd, 3rd                             | A `selectordinal` block in the English                        | The English; each language gets its own ordinal cases |
| Words the English itself changes                      | she, he, they                             | A `select` block in the English                               | The English; translations keep its cases              |
| Words only other languages change                     | "Excited" is _emocionada_ or _emocionado_ | A [declared argument](#4-words-only-other-languages-change)   | Translators, only where their grammar needs it        |
| Several ways to say the same thing, picked by the app | Twenty ways to announce a new job         | An array, or one key per alternative                          | Nobody: each alternative is translated whole          |
| Paragraphs the app joins into one text                | A news story built from parts             | One file or string per paragraph, with folder or file context | Nobody: each paragraph is translated whole            |

## The rules

### 1. One string is one complete sentence or paragraph

Never build a sentence from strings translated separately. Word order differs between languages,
and a translator can't make words agree with a piece they never see.

```json
{
  "joined": "{name} joined {team}."
}
```

not `t("joinedPrefix") + name + t("joinedSuffix")`, and not a team name followed by a translated
"joined".

### 2. Put whole phrases in each case

Each case of a block should read as complete text on its own: the whole sentence, or at least the
whole phrase that changes. Never part of a word.

```text
{gender, select, female {She is hiring.} male {He is hiring.} other {They are hiring.}}
```

not `{gender, select, female {She is} male {He is} other {They are}} hiring.`, and never
`contento{gender, select, female {a} other {o}}`. Whole phrases let each language reorder words and
change more than one of them, and they read clearly in the editor.

### 3. Variation the English shows belongs in the English

If the English changes with a value, write the block in the English. Translators keep the block
and translate each case:

```json
{
  "coins": "{count, plural, one {# coin} other {# coins}}",
  "place": "You finished {place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}."
}
```

Plural and ordinal blocks get the target language's cases, not the English's: Polish writes `one`,
`few`, `many` and `other` for `coins`, Spanish writes only `other` for `place`. The editor and the
LLM are told which cases each language needs, with example numbers; see
[Plural blocks](file-formats.md#plural-blocks).

A `select` in the English keeps its cases in every translation, unless its argument is a
declared argument (below).

### 4. Words only other languages change

English often hides what other languages must show. "Excited to join {company}!" says nothing about
the writer's gender; Spanish says _¡Emocionada…!_ or _¡Emocionado…!_. A translator can only agree
with a value the app passes, so the app declares it in `quaso.config.json`:

```json
{
  "arguments": [
    {
      "name": "authorGender",
      "cases": ["female", "male"],
      "description": "The gender of the person who wrote the post. other: nonbinary, or not known.",
      "files": ["feed.json"],
      "keys": ["posts.*"]
    }
  ]
}
```

- `name` is the argument the app passes to every string in `files` and `keys` (both optional:
  without them, every string).
- `cases` are the values the app passes, besides `other`.
- `description` tells translators and the LLM what the value is and what `other` stands for.

The English stays as it is. Each translation chooses:

| Language | Translation of `"Excited to join {company}!"`                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spanish  | `{authorGender, select, female {¡Emocionada de unirme a {company}!} male {¡Emocionado de unirme a {company}!} other {¡Qué emoción unirme a {company}!}}` |
| French   | `{authorGender, select, female {Ravie de rejoindre {company} !} male {Ravi de rejoindre {company} !} other {Quel plaisir de rejoindre {company} !}}`     |
| German   | `Ich freue mich, bei {company} anzufangen!`                                                                                                              |
| Japanese | `{company}に入社できてうれしいです！`                                                                                                                    |

The rules for a block on a declared argument:

- A translation may add it, leave it out or move it, whether or not the English has one: German
  and Japanese need none here.
- Its cases are the declared ones and `other`. `other` is required: it is the text for every value
  that isn't listed, including a value the app doesn't know. Write it the way the description
  says, often in wording that doesn't show gender.
- Each case must have what the English has: the same placeholders, as if the case stood where the
  block is.

For the app:

- Pass the argument to every string in its scope. A formatter that falls back to `other` when a
  select's value is missing, as FormatJS does, keeps a forgotten value harmless: the reader sees
  the `other` text.
- Declare only values the app really has. A declared argument the app never passes makes every
  translation's specific cases dead text.
- An argument for the whole app (the player's chosen pronouns, say) is declared without `files` and
  `keys`.

### 5. Alternatives are arrays or separate keys

When the app picks one of several ways to say the same thing, at random or by an id, write each
alternative as its own complete string:

```json
{
  "hiredPosts": [
    "Excited to start at {company}!",
    "New job alert: I'm joining {company}!",
    "Day one at {company}. Wish me luck!"
  ]
}
```

Each is translated whole, and translators may adapt each one freely. Don't use a `select` for this:
a select chooses by a value the app passes, not by chance. Say in the file context that these are
alternatives, so the LLM doesn't make them identical.

### 6. Fragments are whole paragraphs, with context

When the app joins texts into one (a news story from an opening, a detail chosen by what happened,
and a closing), make each text a whole paragraph, in its own Markdown document or string. Write a
folder context or file context that says what the fragment is and what comes before
and after it, such as "One paragraph of a news story, after the opening paragraph; no headline".
Managers write both in **Settings → Files & length limits**; see
[Context, reuse, and meaning checks](concepts.md#context-reuse-and-meaning-checks).

If a fragment differs from another only by a phrase inside a sentence, it isn't a fragment: write
one text with a `select` on a value the app passes.

### 7. Values the app inserts that need agreement

A word the app inserts into a sentence, such as a job title in "Proud to be the new {jobTitle}!",
may need the words around it to agree with it: Spanish _el nuevo_ or _la nueva_ depends on the
title. Either pass what the words agree with as a declared argument (`jobTitleGender`), or make the
inserted word part of the message, one message per value. Don't insert translated nouns into
sentences that must agree with them and hope for the best.

## What the LLM is told

For every string in a batch, the LLM gets its English, its description, its placeholders, the
target language's plural or ordinal cases with example numbers, and its declared arguments with
their cases and descriptions. The instructions tell it to keep each block's argument and type,
write the target language's plural cases, keep a select's cases unless it is on a declared
argument, use a declared argument only where the language needs agreement and not to rephrase a
sentence to avoid it, put whole phrases in each case, and write `other` as the argument's
description says.

What you add makes it fit your app:

- **Language instructions** (**Settings → Languages**): how a language writes `other`, such as "In
  Spanish, write `other` in wording that shows no gender; don't use -e or @ endings."
- **String descriptions** (beside the source files): who speaks or is spoken about, when the key
  doesn't say.
- **File and folder context** (**Settings → Files & length limits**): which strings are
  alternatives, and what a fragment comes between.

The checks then read every answer. One that fails is sent back with the reason, and the LLM
corrects it; see [What the checks refuse](#what-the-checks-refuse).

## What the checks refuse

| Problem                                                                           | Check                                           |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| A placeholder missing from a case, or one the English doesn't have                | `placeholder_missing`, `placeholder_extra`      |
| A plural case the language needs is missing, or one it doesn't use is there       | `plural_form_missing`, `plural_form_unexpected` |
| A block is missing or broken, or a select's cases differ from the English's       | `icu_structure`                                 |
| A select on a declared argument has a case that isn't declared, or has no `other` | `icu_structure`                                 |

Errors stop a save and an LLM answer. See [Checks](file-formats.md#checks) for every check.

## In the editor

The source shows each block as an indented tree, one case per line. Beside the translation, the
editor lists the target language's plural cases with example numbers, and the string's declared
arguments with a button that writes a select around the selected text. **Copy the English** copies
the blocks with the target language's plural cases, and a preview under the translation shows the
text for every case.

## Moving an i18next project to ICU

An i18next project (`{{name}}`, `coins_one` and `coins_other`) can move to ICU MessageFormat without
translating or proofreading again: Quaso converts the sources, translations and suggestions in
place and keeps who translated what. See
[Move an i18next project to ICU MessageFormat](file-formats.md#icu-messageformat).
