# Contributing to Quaso

Use the [development guide](docs/contributing/README.md) to run Quaso from source and prepare a
change. It covers setup, commands, package layout, and code conventions.

## Getting started

Follow [development setup](docs/contributing/README.md#getting-started). For translation work on an
existing project, use the [website guide](docs/website.md).

## Writing tests and pull requests

Keep each change focused. Explain the problem, the resulting behavior, and how you checked it.
Include screenshots for visible interface changes and a reason for each new dependency.

Run `npm run check` before review. Use the [testing guide](docs/contributing/testing.md) to choose
additional browser, Cloudflare, or documentation checks for your change. Add a regression test for
a bug that can lose or expose data.

## Adding a migration

Follow the [migration procedure](docs/contributing/README.md#adding-a-migration). Do not edit a
released migration. Describe any effect on backups, upgrades, or deployment in the pull request.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
