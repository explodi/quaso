# Releasing Quaso

Prepare and publish a Quaso release from a tested source commit. This guide is for maintainers with
permission to publish the npm package, Docker image and GitHub release.

Use semantic versions: patch releases fix behavior without breaking compatibility, minor releases
add compatible features, and major releases change public contracts. Test a release candidate before
a stable tag. Document recovery from schema changes, including changes in minor releases. Use the
Deno version in `.dvmrc`, install the locked dependencies with `deno install --frozen-lockfile`, and
have Docker available for the image tests.

## Prepare the files

The `version` in the root `package.json` is the Quaso release version. Core imports it, the server,
CLI, website and Worker report it, and the npm package and the Docker image are published with it
(CI fails if either reports another). The release script changes it there.

Quaso Quest pins an already published CLI independently, so its locked install keeps working while
the next release is being prepared. After publishing a CLI update, run
`npm install --save-dev --save-exact @quaso-i18n/cli@<version>` in `examples/demo-game`, test the
game, and commit both its `package.json` and `package-lock.json`.

The following example prepares `1.0.0-rc.3`. Replace it with the next unused version:

```sh
deno task release 1.0.0-rc.3
deno task fmt
deno task check
deno task build
deno task build:cli
deno task test:binary
deno task site:build
deno task e2e:browser
deno task e2e
deno task cf:check
deno task docker:smoke
deno task docker:workflow
```

`release` accepts one semantic version, sets it in `package.json`, moves Unreleased changelog
entries into a dated section and prints git commands. It does not run git, create tags, publish or
deploy. Review its changes before committing. It refuses a version that already has a dated
changelog section. A prepared `1.0.0 - unreleased` section is replaced when that final version is
chosen. With no new changes, final 1.0.0 notes copy the latest 1.0.0 candidate's notes. Describe
changes made after a candidate under Unreleased.

For a final release, run `deno task release 1.0.0`, repeat the checks, and have the team approve the
candidate and migration results before running the printed tag/push commands. Never reuse a
published version. If publication succeeds in one registry and fails in another, a new version might
be needed. npm does not let you publish another package with the same name and version.

## What a tag publishes

`.github/workflows/release.yml` runs on `v*` tags (and on main, below), verifies versions and tests
the built CLI before publishing. A separate validation gate also requires the complete checks, app
build, browser suite, Cloudflare checks, documentation build and Docker smoke test to pass. The
website workflow also runs on version tags.

| Artifact                       | Destination                                  | Authentication                                             |
| ------------------------------ | -------------------------------------------- | ---------------------------------------------------------- |
| CLI package                    | npm `@quaso-i18n/cli`, with build provenance | npm trusted publishing through OpenID Connect (OIDC)       |
| Server and built website image | Docker Hub `<image>` (see below)             | Repository secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` |
| Project website and docs       | GitHub Pages                                 | GitHub Pages permission and OIDC                           |
| Release notes                  | GitHub release for the tag                   | Workflow `GITHUB_TOKEN` with contents write permission     |

A stable `v1.0.0` image receives `:1.0.0`, `:1.0` and `:1`. `:latest` and `:sha-<commit>` come from
every push to main instead (`.github/workflows/docker.yml`). Prereleases receive their full version
only. On npm, the workflow publishes to `latest` until a stable version exists; after that,
prereleases go to `next`, so the default install selects the stable release once one exists. Check
the workflow results and registry visibility after publishing. The Docker Hub repository needs to be
public for anonymous pulls.

## What every push to main publishes

Besides the image (`:latest` and `:sha-<commit>`, by `docker.yml`), `release.yml` builds and tests
the CLI of every push to main, as for a release, and publishes it to npm under the tag `main`, never
`latest`. Its version is the repository's with the commit appended: `1.0.0-rc.2.main.gae28a74`
(`1.0.0-main.gae28a74` after a stable `1.0.0`), the `g` keeping the identifier valid when the short
hash starts with a digit. A deployment that runs `<image>:sha-ae28a74` pins
`@quaso-i18n/cli@1.0.0-rc.2.main.gae28a74`, so the CLI and the server come from one commit.
`npm install @quaso-i18n/cli@main` takes the latest package published under that tag. These versions
are for deployments that follow main; releases go to `latest` and `next` as above.

The image is `<GitHub owner>/quaso`, or the repository variable `DOCKERHUB_IMAGE` (such as
`yourname/quaso`) when your Docker Hub namespace differs. Before the first tag, add
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to the repository, and enable GitHub Pages with **GitHub
Actions** as its source. npm needs no secret: `release.yml` is the package's trusted publisher, set
once after the package's first, manual publish (npm only trusts existing packages). Follow
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the required account setup.
The `npm trust` command below needs npm 11.15.0 or later; see
[the npm trust reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/). For a fork, replace
`explodi/quaso` with your GitHub repository and `@quaso-i18n/cli` with the `name` in your
`packages/cli/package.json`:

```sh
GITHUB_REPOSITORY=explodi/quaso deno task build:cli
cd packages/cli/dist
npm publish --access public
npm trust github @quaso-i18n/cli --file release.yml --repo explodi/quaso
```

Then, in the package's **Settings → Publishing access** on the npm website, choose **Require
two-factor authentication and disallow tokens**.

The website workflow builds private repositories without publishing them to GitHub Pages.
`BASE_PATH` comes from Pages configuration; an optional `SITE_REPOSITORY_URL` overrides source links
when building outside GitHub.

## Release notes and upgrade instructions

The release workflow extracts the tagged version's changelog section and includes the upgrade steps
and recovery guide. Review notes for operator-visible configuration or schema changes. Include:

- The tested previous release and schemas, and any new or changed settings.
- A backup reminder and the target image version.
- Docker: pin the target image, then `docker compose pull` and `docker compose up -d`.
- Cloudflare: use the tested source tag and matching image, then run
  `deno task cf:deploy --env production`.
- Expected migration behavior, `/healthz` checks and a link to [rollback steps](operations.md).

Do not tag the release until the documented upgrade path has been exercised on retained historical
test databases and a staging copy of representative data. Keep pre-migration backups with the
previous image. Schema migrations are forward-only.

## The clean-room test

Run this test without relying on an existing development setup. Someone who has not worked on the
deployment should follow each deployment guide using a fresh VM or Cloudflare staging environment
and only the published artifacts. Record the version and exact commands, and have them:

1. Deploy, claim setup, configure a project and create an upload API key.
2. Install the published CLI in a new repository, upload JSON and Markdown files, translate and
   download.
3. Invite a contributor, suggest a change and approve it as a manager. Verify the next download.
4. Download a backup, restore to a separate empty instance and compare data and account access.
5. Upgrade from the previous supported version and practice rollback on staging.

Record any undocumented step and fix the guide before release. Real Gemini quality review,
performance checks from each region, screen-reader review and the switch to production need the
team's own accounts, systems and reviewers. Automated local checks do not replace those checks.
