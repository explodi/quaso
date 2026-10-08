# Translation fixture

This small i18next project supplies the development seed, CLI and server integration tests,
Cloudflare comparison fixture, website screenshots, and LLM evaluation. It has English sources,
complete German and Polish translations, partial French translations, and three empty target
languages. Its plurals, references, placeholders and length limit exercise the translation workflow.

`deno task dev` seeds this project, and `deno task cli` uses it when called from the repository root.
Keeping the fixture stable lets tests compare exact translations and string counts.

For the playable French game with English and German waiting to be translated, use
[Quaso Quest](../../../../../../examples/demo-game/README.md). Its Docker instance and CLI
workflow are independent of this populated development project.
