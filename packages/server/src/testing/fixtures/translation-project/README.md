# Translation fixture

This small i18next project supplies the development seed, CLI and server integration tests,
Cloudflare comparison fixture, LLM evaluation, and other development tools. It has English sources,
complete German and Polish translations, partial French translations, and three empty target
languages. Its plural forms, references to other strings, placeholders, and length limit test the translation
workflow. A placeholder is text, such as `{{count}}`, that the game fills in.

`deno task dev` seeds this project, and `deno task cli` uses it when called from the repository root.
Keeping the fixture stable lets tests compare exact translations and string counts.

For the playable French game with English and German waiting to be translated, use
[Quaso Quest](../../../../../../examples/demo-game/README.md). Its Docker instance and CLI
workflow are independent of this populated development project.
