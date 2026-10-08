# Releasing Quaso

Use semantic versions: patch releases fix compatible behavior, minor releases add compatible
features, and major releases change public contracts. Test release candidates such as `1.0.0-rc.1`
before a stable tag. A schema upgrade must have documented recovery steps even in a minor release.

## Prepare the files

The `version` in the root `package.json` is the only version. Nothing else declares one: core
imports it, the server, CLI, website and Worker report it, and the npm package and the Docker image
are published with it (CI fails if either reports another). The release script changes it there,
and updates the demo game's pin of the published CLI.

```sh
deno task release 1.0.0-rc.1
deno task fmt
deno task check
deno task build
deno task build:cli
deno task site:build
deno task e2e
deno task cf:check
deno task docker:smoke
```

`release` accepts one semantic version, sets it in `package.json`, moves Unreleased changelog entries into a
dated section and prints git commands. It never invokes git, tags, publishes or deploys. Review its
diff before committing. An already dated version is refused. A prepared `1.0.0 - unreleased` section
is replaced when that final version is chosen. With no new changes, final 1.0.0 notes copy the
latest 1.0.0 candidate's notes. Describe changes made after a candidate under Unreleased.

For a final release, run `deno task release 1.0.0`, repeat the checks, and have the team approve the
candidate and migration results before running the printed tag/push commands. Never reuse a
published version. A failed multi-registry publication may need a patch version: npm
packages cannot be silently overwritten.

## What a tag publishes

`.github/workflows/release.yml` runs on `v*` tags, verifies versions and tests the built CLI before
publishing. A separate validation gate also requires the complete checks, app build, browser suite,
Cloudflare checks, documentation build and Docker smoke test to pass. The website workflow also runs
on version tags.

| Artifact                       | Destination                            | Authentication                                             |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------------- |
| CLI bundle                     | npm `@quaso-i18n/cli`, with provenance | npm trusted publishing (the workflow's OIDC token)         |
| Server and built website image | Docker Hub `<image>` (see below)       | Repository secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` |
| Project website and docs       | GitHub Pages                           | Workflow Pages permission and OIDC                         |
| Release notes                  | GitHub release for the tag             | Workflow `GITHUB_TOKEN` with contents write permission     |

A stable `v1.0.0` image receives `:1.0.0`, `:1.0` and `:1`. `:latest` and `:sha-<commit>` come
from every push to main instead (`.github/workflows/docker.yml`). Prereleases receive their
full version only, and npm uses the `next` distribution tag rather than `latest`. Check the workflow
results and registry visibility after publishing. The Docker Hub repository needs to be public for
anonymous pulls.

The image is `<GitHub owner>/quaso`, or the repository variable `DOCKERHUB_IMAGE` (such as
`yourname/quaso`) when your Docker Hub namespace differs. Before the first tag, add
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to the repository, and enable
GitHub Pages with **GitHub Actions** as its source. npm needs no secret: `release.yml` is the
package's trusted publisher, set once after the package's first, manual publish (npm only trusts
existing packages). `<package>` is the `name` in `packages/cli/package.json`, which a fork
changes to a name of its own:

```sh
GITHUB_REPOSITORY=<owner>/<repository> deno task build:cli
cd packages/cli/dist && npm publish --access public --tag next
npm trust github <package> --file release.yml --repo <owner>/<repository>
```

Then, in the package's **Settings → Publishing access** on npmjs.com, choose **Require two-factor
authentication and disallow tokens**.

The private development repository builds the site but does not deploy it. `BASE_PATH` comes from Pages configuration; an
optional `SITE_REPOSITORY_URL` overrides source links when building outside GitHub.

## Release notes and upgrade instructions

The release workflow extracts the tagged version's changelog section and includes the upgrade steps
and recovery guide. Review notes for operator-visible configuration or schema changes. Include:

- The tested previous release and schemas, and any new or changed settings.
- A backup reminder and the target image version.
- Docker: pin the target image, then `docker compose pull` and `docker compose up -d`.
- Cloudflare: deploy the tested source checkout with `deno task cf:deploy --env production`.
- Expected migration behavior, `/healthz` checks and a link to [rollback steps](operations.md).

Do not tag the release until the documented upgrade path has been exercised on retained historical
fixtures and a staging copy of representative data. Keep pre-migration backups with the previous
image. Schema migrations are forward-only.

## The clean-room test

Someone who has not worked on the deployment should follow each deployment guide using a fresh VM or
Cloudflare staging environment and only the published artifacts. Record the version and exact
commands, and have them:

1. Deploy, claim setup, configure a project and create an upload API key.
2. Install the published CLI in a new repository, upload i18next files, translate and download.
3. Invite a contributor, suggest a change and approve it as a manager. Verify the next download.
4. Download a backup, restore to a separate empty instance and compare data and account access.
5. Upgrade from the previous supported version and rehearse rollback on staging.

Record any undocumented step and fix the guide before release. Credentials, real Gemini quality
review, regional performance measurements, screen-reader review and production cutover require the
team's own infrastructure and people. Automated local checks do not replace those checks.
