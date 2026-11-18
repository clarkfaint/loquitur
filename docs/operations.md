# Lectern operations

Everything an operator needs to run the hub: the stack it is deployed with, how engines and profiles are
chosen, how the hub is reached over a private network, the backup and restore commands, cache pruning, and how
to upgrade. F§7.1 is the configuration table these variables come from, F§7.2 is the route the backup is taken
through, F§7.3 is the cache the prune cuts back, and F§12 is the deployment this document describes.

## What runs where

| Piece | What it is | Where it comes from |
|---|---|---|
| `hub` | The API server: F§7.2's routes, F§8's storage, F§9's AI routes | `infra/Dockerfile`, runtime stage; `node:24.22.3-bookworm-slim`, `CMD ["node", "dist/server.mjs"]` |
| `kokoro` | F§6's always-on engine | `ghcr.io/remsky/kokoro-fastapi-cpu:v0.3.0`, reachable as `http://kokoro:8880` |
| `piper` | F§6's optional engine, off unless its profile is asked for | the Dockerfile's `piper` stage (`piper-tts[http]`), reachable as `http://piper:5000` |
| `llm` | F§9's optional AI endpoint, off unless its profile is asked for | `ollama/ollama:0.13.0`, reachable as `http://llm:11434/v1` |
| `lectern-data` | One volume holding everything the hub writes | mounted at `/data` in the `hub` container |

Only the hub publishes a port (`8787:8787`); every engine is reachable on the compose network alone, which is
what `KOKORO_URL`, `PIPER_URL` and `LLM_BASE_URL` point at. The stack's project name is `lectern`, so the volume
is `lectern_lectern-data` and the network is `lectern_default`.

The restore command and the cache prune are **not** in the image — the runtime stage carries the server bundle
alone — so they run from a checkout of this repository against the same data directory (see *Backup and
restore*). That is a deliberate limit to record rather than hide; F§12's other backup form, a copy of the
volume while the hub is stopped, is always available whatever runs the commands.

## Configure

```sh
cp -n infra/.env.example infra/.env      # the copy is git-ignored, so no token reaches the repository
```

Then edit `infra/.env`:

- **`LECTERN_TOKEN`** — required, at least 32 random characters (F§7.1, F§11). It is the only authentication the
  hub has, and every route but `/healthz` requires it as `Authorization: Bearer …`.
- `LECTERN_PORT`, `LECTERN_DATA_DIR` — the listen port (default `8787`) and where the data lives. Under compose
  the data directory is `/data`, the volume's mount point.
- `KOKORO_URL`, `PIPER_URL` — the engines to enable. An empty value counts as unset, so a commented line and an
  empty one mean the same thing.
- `LECTERN_ENABLE_MOCK` — `1` adds the `mock` engine for development and for F§6's conformance checks. Never in
  a real deployment: it synthesizes placeholder audio.
- `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` — F§9's AI endpoint. Both a URL and a model are needed to switch
  the AI routes on; the compose default URL already names the `llm` profile's service, so naming `LLM_MODEL` is
  normally the whole job.
- `LECTERN_MAX_UPLOAD_MB`, `LECTERN_ALLOW_PRIVATE_FETCH` — the upload and URL-fetch size limit, and whether
  `POST /v1/parse` may fetch addresses on the private network. Leave the second at `0` unless the hub is meant
  to read from the operator's own network.

## Deploy with compose

```sh
docker compose -f infra/docker-compose.yml up -d --build      # the hub and its always-on engine
curl -fsS http://127.0.0.1:8787/healthz                       # { "ok": true, "version": …, "engines": […] }
curl -fsS -H "Authorization: Bearer $LECTERN_TOKEN" \
     http://127.0.0.1:8787/v1/voices                          # the voices the enabled engines offer
```

A profile is asked for by name, and the engine's URL is set beside it — compose cannot switch a variable on with
a profile, so the hub learns about the engine from the environment:

```sh
PIPER_URL=http://piper:5000 docker compose -f infra/docker-compose.yml --profile piper up -d
docker compose -f infra/docker-compose.yml --profile llm up -d     # with LLM_MODEL set in infra/.env
```

The hub answers 401 to any request without a valid token, the engines answer nothing on the host at all, and
`/healthz` is the one route left open so a supervisor can tell the hub is up. The image's own health check is
that same route, so `docker compose ps` shows the hub's state without any extra tooling.

## Reaching the hub over a private network

The hub listens on every interface inside its container, and compose publishes `8787` on the host. The practical
rules:

- **Keep it on a private network.** The stack has no TLS, and the token travels in a header: reach the hub over
  the operator's own VPN (WireGuard, Tailscale, or whatever they already run) rather than the open internet. If
  the host has a public address, a firewall rule that admits only the private ranges is what stands between the
  hub and the world.
- **Bind the published port when the hub is only for this machine.** Changing the mapping in the operator's own
  copy of the compose file to `127.0.0.1:8787:8787` keeps the port off the LAN entirely, and a client on another
  device reaches it through the VPN instead.
- **A reverse proxy adds TLS, not authentication.** Terminating TLS in front of the hub is fine; the hub still
  checks the same bearer token, and nothing else may be trusted to do it for it (F§11).
- **The token is per deployment.** Every client — the web app, the extension, the desktop app, a phone — is
  configured with the same one, and rotating it means editing `infra/.env` and restarting the hub.

## Backup and restore

### Take a backup

`GET /v1/admin/backup` streams a `tar.gz` of the hub's data directory:

```sh
curl -fsS -H "Authorization: Bearer $LECTERN_TOKEN" \
     http://127.0.0.1:8787/v1/admin/backup -o lectern-$(date +%F).tar.gz
curl -fsS -H "Authorization: Bearer $LECTERN_TOKEN" \
     "http://127.0.0.1:8787/v1/admin/backup?includeAudio=1" -o lectern-with-audio-$(date +%F).tar.gz
```

The archive holds:

| Member | What it is |
|---|---|
| `lectern.db` | A consistent snapshot of F§8.4's database, taken through SQLite's online backup API while the hub keeps serving |
| `library/**` | Each document's gzipped model and its original file, exactly as clients uploaded them (F§8.4) |
| `tts-cache/**` | F§7.3's synthesized audio and metadata — only with `includeAudio=1` |
| `manifest.json` | `{ createdAt, schemaVersion, files }`: when the archive was taken, the schema version it was written at, and every payload path it holds |

It does **not** hold the token, `infra/.env`, OCR language data, or F§5.5's cached training data, and it never
contains the live database file or its write-ahead siblings — only the snapshot. A backup is therefore safe to
move between machines and safe to keep beside other backups. Audio is the one expensive member: without
`includeAudio=1` every chunk is simply synthesized again the next time it is played.

The other backup form F§12 allows is a copy of the volume with the hub stopped:

```sh
docker compose -f infra/docker-compose.yml down
docker run --rm -v lectern_lectern-data:/data -v "$PWD/backups:/backups" \
  node:24.22.3-bookworm-slim tar -czf /backups/lectern-volume-$(date +%F).tar.gz -C /data .
docker compose -f infra/docker-compose.yml up -d
```

### Build the commands

The restore and prune commands are TypeScript in `apps/server/src/cli`, and both are part of the package's
build:

```sh
pnpm install --frozen-lockfile
node apps/server/build.mjs      # writes dist/server.mjs, dist/restore.mjs and dist/prune-cache.mjs
```

The two commands are self-contained files: `dist/restore.mjs` carries everything it reads an archive with, and
`dist/prune-cache.mjs` needs nothing but Node, so either runs from a checkout, from a mounted directory, or from
a container image of the operator's own. The hub's own `dist/server.mjs` is different: it leaves the parsing
package's native and worker-based dependencies to `node_modules`, which is the tree the image's build stage
installs, so the hub runs inside its container (`docker compose … up -d`) rather than from a checkout — a
checkout runs the hub through `pnpm --filter @lectern/server dev` instead.

### Restore

```sh
node apps/server/dist/restore.mjs <archive> <dataDir>
```

The archive is read and checked **before** anything is written, and the command refuses, with exit code 1 and a
sentence saying which case it is, when:

- the target directory already holds anything at all — a restore never writes over a hub. An empty directory
  (a fresh volume, or one just created) is what a restore into a new deployment looks like;
- an entry path is absolute, contains `..`, or is anything but a regular file or a directory — so an archive
  cannot reach outside the directory it is restored into;
- there is no manifest, the manifest is not this format, or it names a schema version this build cannot read;
- the archive's own file list disagrees with its manifest, in either direction.

A refusal leaves the target directory exactly as it was. A successful restore prints how many files it wrote,
the schema version, and when the backup was taken, and the restored directory is a hub's data directory in
full: point a hub at it and the library, the sync records and the models are all there.

Under compose the target is the data volume, and because the target must be empty, restoring means building a
fresh volume and letting the stack use it:

```sh
docker compose -f infra/docker-compose.yml down
docker volume create lectern-data-restored
docker run --rm \
  -v lectern-data-restored:/data \
  -v "$PWD/backups:/backups:ro" \
  -v "$PWD/apps/server/dist:/dist:ro" \
  node:24.22.3-bookworm-slim \
  node /dist/restore.mjs /backups/lectern-2026-11-18.tar.gz /data
```

Then make the stack use the restored volume — change the volume name `lectern-data` in the operator's own copy
of the compose file, or park the old volume and reuse its name — and start it again. Keep the parked volume until
the restored hub has been checked: it is the rollback.

Restoring is never automatic and there is no scheduled job: a backup nobody has restored is a hope, so the
useful habit is to restore the newest archive into a scratch directory and check the library before trusting it.

### Prune the cache

F§7.3's cache never evicts itself, so it only grows. The prune removes whole cache entries — an audio file and
its metadata sidecar together — whose newest file has not been modified for the given number of days:

```sh
LECTERN_DATA_DIR=/data node apps/server/dist/prune-cache.mjs --days 30 --dry-run
LECTERN_DATA_DIR=/data node apps/server/dist/prune-cache.mjs --days 30
```

`--days` is required and must be a whole number of days; `--dry-run` prints the same counts and bytes and
deletes nothing, and the real run prints how many of how many entries it removed and how many bytes that freed:

```
would prune 12 of 41 cache entries (184320000 bytes) under /data
pruned 12 of 41 cache entries (184320000 bytes) under /data
```

Nothing else in the data directory is touched: documents, models, originals and the database are not the
command's business. Reaching the volume from the host is the same `docker run` recipe as a restore, with
`-e LECTERN_DATA_DIR=/data` and `node /dist/prune-cache.mjs --days 30`.

## Upgrade

```sh
# 1. Take a backup and keep it somewhere else.
curl -fsS -H "Authorization: Bearer $LECTERN_TOKEN" \
     http://127.0.0.1:8787/v1/admin/backup -o lectern-before-upgrade.tar.gz

# 2. Get the new build.
git pull
pnpm install --frozen-lockfile

# 3. Rebuild and restart, then check health and voices.
docker compose -f infra/docker-compose.yml build hub
docker compose -f infra/docker-compose.yml up -d
curl -fsS http://127.0.0.1:8787/healthz
```

The database takes itself to the current schema when the hub starts: migrations are numbered, applied once each
inside a transaction, and recorded, so starting a new build over an old volume is the upgrade. A backup carries
the schema version it was written at (`SCHEMA_VERSION`, the highest migration the build applies), and the
restore command refuses an archive either newer than the build reading it or older than one this build can
migrate — which is why the backup in step 1 is the rollback: restore it, start the previous build, and the hub
is where it was.

Clients are upgraded on their own schedules — a browser that reloads the web app, an extension that updates
itself, an app installed from its own build. Nothing in the hub requires a client to move first, because F§8's
records and F§5.1's documents are versioned by their own identifiers rather than by the hub's build.
