# Demo game

A small, made-up game that uses [i18next](https://www.i18next.com/), for trying Quaso.
`deno task dev` seeds a development instance from it, and it shows what a game needs to work with
Quaso:

- `quaso.config.json`: the source language, the languages to translate into, where the English files
  are (`src/locales/en/**/*.json`) and where translations go (`src/locales/{lang}/{path}`), and a
  length limit for the store title.
- `src/locales/en/`: the English files, with plain text, plurals (`coins`, `lives`, `items`, with a
  `_zero` form), an ordinal (`gameOver.place`), context keys (`companion_cat`, `companion_dog`), an
  array (`hints`), placeholders (`{{name}}`, `{{count}}`, `{{current}}` and `{{total}}`), a nesting
  reference (`$t(common:play) again`) and a reference-only entry (`main.back`).
- `src/locales/de/` and `src/locales/pl/`: complete translations, and `src/locales/fr/`: a partial
  one. The development seed imports German as proofread (blue), and Polish and French as unproofread
  (green). Japanese, Arabic and Brazilian Portuguese start empty.
- `src/game.js`: how the game looks its strings up.

With the development server running (`deno task dev`), the CLI works against it: set
`QUASO_HOSTNAME=http://localhost:8000` and `QUASO_API_KEY` to the development key that
`deno task dev` prints (it is also in `.quaso/dev-api-key`).

## Run the example

After the release-candidate CLI is published, run `npm install` in this directory, then
`npm run demo -- pl`. `src/i18n.js` loads JSON with i18next; no bundler or server is needed. Missing
target files fall back to English. The pinned CLI in `package.json` makes the example's workflows
reproducible once that version is available.

Copy `.github/workflows/translations-upload.yml` and `translations-download.yml` into your game
repository. Set variable `QUASO_HOSTNAME` and secret `QUASO_API_KEY`. Upload runs on source changes;
download runs manually or from a release preparation workflow and opens a pull request after the
translation completeness gate passes. Merge it before creating your release tag. See
[Add Quaso to your game](../../docs/add-to-your-game.md) for details and monorepo adjustments.
