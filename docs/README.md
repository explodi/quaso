# Quick start

Quaso translates your game's new strings with an LLM as soon as you upload them, so every build
ships in every language. People proofread afterwards, and each download brings their fixes.

This page takes you from nothing to a build that speaks every language, in four steps: host Quaso,
connect your game, translate, and download. You need a game that uses
[i18next](https://www.i18next.com/) JSON files, and somewhere to run Quaso.

> **Just looking?** [Quaso Quest](../examples/demo-game/README.md) is a small playable game that
> runs its own Quaso on your computer with one command. No server, domain or key needed.

## 1. Host your Quaso

Each game runs its own Quaso instance, at an address such as `translate.yourgame.com`. Pick where
it runs:

<!-- tabs -->

### Docker Compose

The simplest setup, and the one most teams should use: one container on any Linux VM, with its
database and files on one volume.

You need a VM with Docker Engine and the Compose plugin, inbound ports 80 and 443 open, and a DNS
`A` record that points your hostname at the VM.

On the VM, download the three deployment files:

```sh
mkdir quaso && cd quaso
files=https://raw.githubusercontent.com/explodi/quaso/main/deploy
curl -fsSLO "$files/compose.yaml"
curl -fsSLO "$files/Caddyfile"
curl -fsSL "$files/.env.example" -o .env
```

Make a setup key with `openssl rand -hex 16`, then set two values in `.env`:

```dotenv
QUASO_DOMAIN=translate.yourgame.com
SETUP_KEY=the-key-you-just-made
```

Start Quaso:

```sh
docker compose up -d
```

Caddy gets the HTTPS certificate for your hostname by itself. More in
[Deploy with Docker Compose](deploy-docker.md): backups, upgrades and troubleshooting.

### Cloudflare

For teams that already use Cloudflare, with no server to look after: Quaso runs in a Cloudflare
Container behind a Worker, with D1 as its database and R2 for its files.

You need a Cloudflare account on the **Workers Paid** plan, a domain on Cloudflare, and
[Deno](https://deno.com/) 2.9.6 with git.

Get Quaso's deployment scripts and sign in to Cloudflare:

```sh
git clone https://github.com/explodi/quaso.git
cd quaso
deno install
cd packages/cloudflare
deno run -A npm:wrangler login
cd ../..
```

Create the instance:

```sh
deno task cf:setup --env production --hostname translate.yourgame.com \
  --image explodi/quaso:1.0.0-rc.2
```

`cf:setup` creates the database and the bucket, deploys the Worker, which pulls the image from
Docker Hub, and waits until your hostname answers. It asks for anything you left out, such as where
to keep the data, and prints the **setup key** once: save it. Also keep a copy of
`quaso.cloudflare.jsonc`, which it writes at the repository's root: every later deploy reads it.

More in [Deploy on Cloudflare](deploy-cloudflare.md): updates, backups and Time Travel.

<!-- /tabs -->

When the instance is up, open `https://translate.yourgame.com/setup`. Enter the setup key, name
your project, choose its source language, and create your administrator account.

## 2. Connect your game and upload

In Quaso, open **Settings → API keys** and create a key with the **upload** scope. Copy it now: it
is shown once.

In your game's repository, install the CLI (it needs Node 22 or later) and connect it to your
instance:

```sh
npm install --save-dev @quaso-i18n/cli
export QUASO_HOSTNAME=translate.yourgame.com
export QUASO_API_KEY=qso_your_key
```

Tell Quaso where your files are and which languages you want:

```sh
npx quaso init --languages de,fr,ja
```

```text
Wrote quaso.config.json
  Source language: en
  Languages:       de, fr, ja
  Source files:    src/locales/en/**/*.json (2 files found)
  Translations:    src/locales/{lang}/{path}
```

`init` expects your English files in `src/locales/en/`. If they live elsewhere, add
`--files 'public/locales/{source}/*.json'`, or edit `quaso.config.json` afterwards; another source
language takes `--source`. Then upload them:

```sh
npx quaso upload
```

```text
Uploading 2 files to https://translate.yourgame.com…
  src/locales/en/common.json  new  3 added
  src/locales/en/game.json    new  1 added

Languages added on the instance: de, fr, ja

2 files uploaded (revision 9).
```

Commit `quaso.config.json` and your lockfile; keep the API key out of git. The CLI never changes
your source files.

## 3. Translate

Let the LLM translate everything at once, translate by hand, or both: the LLM never overwrites a
translation that a person has proofread.

<!-- tabs -->

### With the LLM

In Quaso, open **Settings → LLM translation** and enter a Gemini API key, which you can create in
[Google AI Studio](https://aistudio.google.com/apikey). Then translate everything you have
uploaded:

```sh
npx quaso translate
```

The command shows the job's progress and waits for it to finish. Each translation passes the same
quality checks as a person's (placeholders, plurals, length limits) and turns **green**: translated,
ready to ship, not yet proofread.

From now on, every `quaso upload` translates its new and changed strings by itself. Proofreaders
turn green translations **blue** later, at their own pace.

### By hand

No key needed. Open your instance, choose a language, and press **Translate all**. Type a
translation and press **Save**, or Ctrl+Enter (⌘+Enter on a Mac) to save and go to the next string.
Your translations are **blue**: proofread.

To get help, invite your team and community from **Team**: volunteers suggest translations, and
managers review them. [Translating and reviewing on the website](website.md) covers the editor, its
shortcuts and the review queue.

<!-- /tabs -->

## 4. Download, ship and celebrate

Bring every language into your repository:

```sh
npx quaso download
```

```text
Downloading 3 languages from https://translate.yourgame.com…
  created      src/locales/de/common.json
  created      src/locales/de/game.json
  created      src/locales/fr/common.json
  created      src/locales/fr/game.json
  created      src/locales/ja/common.json
  created      src/locales/ja/game.json
Wrote 6 files, 0 unchanged.
```

They are ordinary i18next JSON files: your game loads them like any other, with no connection to
Quaso. A string nobody has translated yet is written in the source language, so every file has
every key. Commit, build, and ship your game in four languages. 🎉

From here, the loop is two commands. Run `npx quaso upload` whenever your source text changes, and
`npx quaso download` before each release: every download brings the latest translations and the
proofreaders' fixes. To stop a release while strings are still untranslated, add
`npx quaso status --fail-on untranslated` to your release checks: it exits with code 7.

## Next steps

- [Automate uploads and downloads in CI](add-to-your-game.md#ci), and set
  [paths, languages and length limits](add-to-your-game.md#configure-paths-and-languages).
- [Follow a complete workflow](workflow.md): reference languages, auto-translation of a selection,
  and reviewing before you commit.
- [Learn the CLI](cli.md): every command, JSON output and exit codes, also
  [for AI agents](cli.md#for-ai-agents).
- [Keep your instance safe](operations.md): backups, restores and upgrades.
- [Move from Crowdin](migrate-from-crowdin.md) with your translations and their proofread state.
- [Work on Quaso itself](../CONTRIBUTING.md): `deno task dev` runs a complete instance with no
  accounts or keys.
