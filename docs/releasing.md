# Releasing Quaso

Use semantic versions: patch releases fix compatible behavior, minor releases add compatible
features, and major releases change public contracts. Test release candidates such as `1.0.0-rc.1`
before a stable tag. A schema upgrade must have documented recovery steps even in a minor release.

## Prepare the files

`packages/core/src/version.ts` is the canonical runtime version. Both server and CLI import it.
Package metadata repeats the version because npm requires it; the release script synchronizes
every Quaso package's version, including the service, server, private front ends and Cloudflare
package, and the demo CLI pin.

```sh
bun run release 1.0.0-rc.1
bun run fmt
bun run check
bun run build
bun run build:cli
bun run site:build
bun run e2e
bun run cf:check
bun run docker:smoke
```

`release` accepts one semantic version, updates metadata, moves Unreleased changelog entries into a
dated section and prints git commands. It never invokes git, tags, publishes or deploys. Review its
diff before committing. An already dated version is refused. A prepared `1.0.0 - unreleased` section
is replaced when that final version is chosen. With no new changes, final 1.0.0 notes copy the
latest 1.0.0 candidate's notes. Describe changes made after a candidate under Unreleased.

For a final release, run `bun run release 1.0.0`, repeat the checks, and have the team approve the
candidate and migration results before running the printed tag/push commands. Never reuse a
published version. A failed multi-registry publication may need a patch version: npm
packages cannot be silently overwritten.

## What a tag publishes

`.github/workflows/release.yml` runs on `v*` tags, verifies versions and tests the built CLI before
publishing. A separate validation gate also requires the complete checks, app build, browser suite,
Cloudflare checks, documentation build and Docker smoke test to pass. The website workflow also runs
on version tags.

| Artifact                       | Destination                       | Authentication                                         |
| ------------------------------ | --------------------------------- | ------------------------------------------------------ |
| CLI bundle                     | npm `@quaso/cli`, with provenance | Repository secret `NPM_TOKEN`                          |
| Server and built website image | `ghcr.io/<org>/quaso`             | Workflow `GITHUB_TOKEN` with packages write permission |
| Project website and docs       | GitHub Pages                      | Workflow Pages permission and OIDC                     |
| Release notes                  | GitHub release for the tag        | Workflow `GITHUB_TOKEN` with contents write permission |

A stable `v1.0.0` image receives `:1.0.0`, `:1.0`, `:1` and `:latest`. Prereleases receive their
full version only, and npm uses the `next` distribution tag rather than `latest`. Check the workflow
results and registry visibility after publishing. GHCR packages need to be public for anonymous
pulls.

Before the first tag, reserve the npm package name, add `NPM_TOKEN` to the
repository, and enable GitHub Pages with **GitHub Actions** as its source. The private development
repository builds the site but does not deploy it. `BASE_PATH` comes from Pages configuration; an
optional `SITE_REPOSITORY_URL` overrides source links when building outside GitHub.

## Release notes and upgrade instructions

The release workflow extracts the tagged version's changelog section and includes the upgrade steps
and recovery guide. Review notes for operator-visible configuration or schema changes. Include:

- The tested previous release and schemas, and any new or changed settings.
- A backup reminder and the target image version.
- Docker: pin the target image, then `docker compose pull` and `docker compose up -d`.
- Cloudflare: deploy the tested source checkout with `bun run cf:deploy --env production`.
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
