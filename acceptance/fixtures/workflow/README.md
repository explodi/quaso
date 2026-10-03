# Beta 2 workflow fixture

This is fictional test data for B2.27, separate from the demo game and adopter content.
Copy `project/` into a temporary workspace; do not mutate this fixture during a run.

- `project/`: five baseline English files, `quaso.config.json`, and matching Crowdin YAML.
- `updated/`: the same five files with one new key each and a changed `menu.json:map`.
- `crowdin-approved/`: all Spanish entries and the two `buildings.json` entries in each
  other language, with the project's translation paths beneath the export root.
- `crowdin-full/`: every baseline key in every target language.
- `expected.json`: file/language lists, counts, new keys and the changed key for the runner.

The ten languages are `de`, `es`, `fr`, `it`, `ja`, `ko`, `pl`, `pt-PT`, `tr` and
`zh-Hans`; Portuguese retains folder `pt`, and Simplified Chinese retains `zh`.
`tutorial/steps.json` exercises nested paths. Export values have a language prefix to
make English fallbacks detectable; they are synthetic values, not language-quality samples.

Initially there are ten strings and twenty source words. Import approved as blue, then
full as green, without overwrite. Spanish is 100% translated and proofread; the other
languages are 100% translated with two blue and eight green strings (20% proofread words).

After copying `updated/src/locales/en/` over the source folder and uploading, there are
fifteen strings and thirty-one words. Each language has five missing strings (ten words)
and one outdated translation. The first five Spanish queue entries are the new keys;
the sixth is the changed map key. Translate all six to reach Done and 100% proofread.
This includes the outdated entry needed for the full workflow's final state.

For conversion, use `init --from-crowdin crowdin.yml --languages de,es,fr,it,ja,ko,pl,pt-PT,tr,zh-Hans`
in a temporary copy without an existing Quaso config. The YAML mappings retain `pt` and
`zh`. The separate exports are consumed with `import --from`, not copied over the project.

Verify the fixture's import counts and queue preconditions with:

```sh
bun test acceptance/workflow_fixture.test.ts
```

This check validates the data on the real SQLite service. The full browser/CLI workflow
runs with `bun test e2e/workflow.test.ts --timeout 180000` after `bun run build:cli`.
The same runner targets an instance URL through `bun run workflow --url URL`; see the
[testing guide](../../../docs/contributing/testing.md#the-fake-translator) for credentials,
stub requirements and cleanup. Docker execution, Cloudflare staging execution and the
release gate remain separate B2.27 deliverables.
