<p align="center">
  <img src="packages/design-system/src/assets/quaso-cat.svg" width="256" height="208" alt="Quaso, a tiny gray cat tucked into a golden croissant" />
</p>

# Quaso

An open-source localization platform for games that use [i18next](https://www.i18next.com/)
JSON files. **Ship every language today, proofread tomorrow:** translations never hold up a
release.

Developers write in one source language and upload the files with a CLI. An LLM translates new
strings at once, and the CLI downloads them into the repository, so the next build ships in every
language. Your team and community proofread on a public website at their own pace, and each fix
reaches the build after. Each game runs its own instance, for example at
`translate.yourgame.com`, with Docker Compose on a VM or on Cloudflare.

- **No limits** on words, strings or languages. Only storage and the LLM bill limit an instance.
- **Ship now, proofread later.** LLM translations pass the quality checks and go into the next
  download; proofreading improves them build after build. `quaso status --fail-on green` holds a
  release for a language that must be proofread first.
- **Your files are never at risk.** The CLI never changes the source files, downloads are
  byte-stable, and suggestions waiting for review never reach the files.
- **Human work is never lost.** The LLM never overwrites a proofread translation, and every change
  is kept in history.
- **Easy to run.** One Deno application and one SQLite database, in one Docker container.

Quaso 1.0 is in release-candidate testing. See the [documentation](docs/README.md) and
[release process](docs/releasing.md). The public package names and registry publishing must be set
up before installing release artifacts; development works from this repository.

![Quaso dashboard with progress for each language](site/public/screenshots/dashboard.png)

![Quaso Quest’s French-to-English plural editing with source text and quality checks](site/public/screenshots/editor-plurals.png)

![The Quaso translation workspace in dark mode](site/public/screenshots/editor-dark.png)

## Quick start

| I want to…                         | Read                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| Deploy Quaso with Docker Compose   | [docs/deploy-docker.md](docs/deploy-docker.md)               |
| Deploy Quaso on Cloudflare         | [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)       |
| Add Quaso to my game               | [docs/add-to-your-game.md](docs/add-to-your-game.md)         |
| Play a game and try translating it | [Quaso Quest](examples/demo-game/README.md)                  |
| Run the translation workflow       | [docs/workflow.md](docs/workflow.md)                         |
| Use the CLI                        | [docs/cli.md](docs/cli.md)                                   |
| Move from Crowdin                  | [docs/migrate-from-crowdin.md](docs/migrate-from-crowdin.md) |
| Work on Quaso                      | [CONTRIBUTING.md](CONTRIBUTING.md)                           |

## Working on Quaso

You need [Deno](https://deno.com/) 2.9.6 (pinned in `.dvmrc`) and git:

```sh
git clone 'https://github.com/explodi/quaso.git'
cd quaso
deno install --frozen-lockfile
deno task dev
```

`deno task dev` starts a working Quaso with a demo project, hot reloading, a signed-in developer
account and a fake translator, with no accounts, keys, Docker or cloud services. See
[CONTRIBUTING.md](CONTRIBUTING.md).

This populated development project uses a stable translation fixture. To try translating a game
from scratch, [Quaso Quest](examples/demo-game/README.md) has French source text, empty English and
German targets, and its own Docker Compose setup.

## Licence

[MIT](LICENSE).
