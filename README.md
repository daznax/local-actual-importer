# local-actual-importer

A small Node.js service that watches a folder for bank CSV exports and imports them into [Actual Budget](https://actualbudget.org/) using the official `@actual-app/api` package. It runs in Docker on my Ubuntu home server.

Drop a CSV into a network share, and a few seconds later a push notification says the transactions are ready to review in Actual.

> Personal project, written for my own setup. It is not a general-purpose tool, but the pieces are documented here so future me (or anyone curious) can rebuild it.

## How it works

```
 Samba share (only this folder is exposed)
 .../actual-files      <- drop CSV here
        |
        v  1. file is picked up (after it stops changing for 2 s)
   /files/wip          <- 2. processed one file at a time
        |
        v  3. transactions imported via the Actual API
   /files/complete     <- 4a. success
   /files/failed       <- 4b. any error
        |
        v
   ntfy push notification (5)
```

1. A CSV lands in `actual-files`, which is shared on the local network via Samba.
2. The file is moved out of the share into `files/wip/`, which is local to the docker container.
3. The transactions are parsed and imported through the Actual API.
4. The file moves to `files/complete/` (or `files/failed/` if anything went wrong).
5. A push notification goes out through [ntfy](https://ntfy.sh/). Failures send a high-priority notification.

Only `actual-files` is shared. `wip/`, `complete/` and `failed/` are not exposed on the network.

### Behavior details

- **Watcher:** `chokidar` on `SHARED_DIR`, non-recursive. Files already in the folder at startup are picked up too, so anything dropped while the service was down still gets processed. A file is only processed once it has been stable for 2000 ms (so half-copied files are ignored). Files are processed one at a time through a queue.
- **Account matching:** the account is chosen by checking whether the **filename contains an account `name`** from `config.json` (case-insensitive). A file must be named something like `BMO Bank 2026-11.csv`. If no account name matches, the file fails.
- **Dates:** hardcoded to `MM/DD/YYYY` in the importer.
- **Amounts:** read from a single amount column, or from separate credit/debit columns if configured. Handles `$`, commas, and `(parentheses)` for negatives. Each account can set `invertAmount`.
- **Duplicates:** every transaction gets a stable `imported_id` (a truncated SHA-1 of date, amount and payee, plus an occurrence counter for identical rows), and the import uses `importTransactions`. Re-importing the same file is safe.
- **Failures:** non-`.csv` files, unmatched accounts, parse errors and Actual API errors all move the file to `failed/` and send a high-priority ntfy notification.
- **Logs:** stdout only. Use `docker compose logs -f`.

## Repo layout

| Path | Purpose |
|---|---|
| `app/importer.mjs` | The service |
| `app/config.json` | Date format, accounts and column mappings, `skipImport` |
| `app/package.json`, `app/package-lock.json` | Dependencies (the lockfile pins `@actual-app/api`) |
| `Dockerfile` | Two-stage build on `node:22-slim` |
| `compose.yaml` | Service definition |
| `.env.example` | Template for `.env` (secrets and settings, not committed) |
| `.dockerignore`, `.gitignore` | Ignore rules |

<!-- VERIFY: the Dockerfile and compose.yaml copy from ./app/, so the code files should live in app/. Confirm this matches the repo tree. -->

## Setup

### Prerequisites

- Docker with the Compose plugin on the server
- A running Actual Budget server, **with its port published on the host** (the importer reaches it through `host.docker.internal`, see below)
- A folder on the server that is shared over Samba
- An ntfy topic (public `ntfy.sh` with a long random topic name works; self-hosting is optional)

### 1. Clone the repo

The code has to be on the server's disk, because `build: .` builds from the local folder.

```bash
git clone https://github.com/daznax/local-actual-importer.git
cd local-actual-importer
```

### 2. Create the shared folder

```bash
mkdir -p /mnt/storage/shares/actual-files/
```

Share **only** `.../actual-files/new` over Samba. The container user needs write access to it, because moving a file out of the share deletes it from the share. Samba options such as `force user` and `create mask` help here.

Find the UID/GID the container should run as:

```bash
id -u && id -g
```

### 3. Configure `.env`

```bash
cp .env.example .env
```

Then fill it in. Settings the importer reads:

| Variable | Required | Meaning |
|---|---|---|
| `ACTUAL_SERVER_URL` | yes | URL of the Actual server. **Cannot be `localhost`** inside the container. With the provided `compose.yaml`, use `http://host.docker.internal:5006` |
| `ACTUAL_PASSWORD` | yes | Actual server password |
| `ACTUAL_SYNC_ID` | yes | Budget Sync ID (Actual: Settings > Show advanced settings > Sync ID) |
| `ACTUAL_BUDGET_PASSWORD` | no | Only if the budget file has its own encryption password |
| `NTFY_URL` | yes | ntfy topic URL |
| `NTFY_TOKEN` | no | ntfy access token, if the topic needs one |
| `SHARED_DIR`, `BASE_DIR`, `ACTUAL_DATA_DIR` | set by compose | Container paths. `compose.yaml` overrides whatever is in `.env` (see below) |

Values used only by `compose.yaml`:

| Variable | Default | Meaning |
|---|---|---|
| `PUID` / `PGID` | `1000` / `1000` | User and group the container runs as |
| `HOST_FILES_DIR` | `/mnt/storage/shares/actual-files` | Host path to the shared folder. Mounted at `/files/new` in the container |

<!-- VERIFY: compare this table with .env.example (variable names, ntfy format) and fix any mismatches. -->

### 4. Configure `app/config.json`

```jsonc
{
  "dateFormat": "MM/DD/YYYY",
  "skipImport": false,
  "accounts": [
    {
      "id": "<Actual account id>",
      "name": "BMO Bank",          // must appear in the CSV filename
      "columns": { /* CSV column mapping */ },
      "invertAmount": false
    }
  ]
}
```

<!-- VERIFY: paste the real config.json shape here (column mapping keys especially). The above is only a sketch based on my notes. -->

Things to know:

- **`skipImport: true` is a dry run.** It prints the parsed transactions to the console and does nothing else; the file is left in `wip/`. It must be `false` for real imports.
- `config.json` is read **once at startup**. `compose.yaml` bind-mounts it read-only over the copy in the image, so you can edit it without rebuilding, but you must `docker compose restart` afterwards.
- Finding an account's `id`: open the account in Actual and copy the ID from the URL.

<!-- VERIFY: confirm the "account id from URL" tip is how I actually found the IDs. -->

### 5. Start it

```bash
docker compose up -d --build
docker compose logs -f
```

Drop a test CSV (named after an account) into the share and watch the logs. A good first run is with `skipImport: true`, then flip it to `false` once the parsed output looks right.

## Docker details

### Dockerfile

- Two stages on `node:22-slim`. The build stage installs `python3 make g++` because `@actual-app/api` depends on `better-sqlite3`, a native module that may need to compile if there is no prebuilt binary for the platform.
- Dependencies come from `npm ci --omit=dev`, so the lockfile decides the exact `@actual-app/api` version.
- The runtime stage copies only `node_modules`, `package.json`, `importer.mjs` and `config.json`.
- It creates `/files/wip`, `/files/complete` and `/files/failed` and makes `/files` writable (`chmod -R 777`), because the container runs as a non-root user and Docker would otherwise create `/files` root-owned.

### compose.yaml

- `restart: unless-stopped`, runs as `${PUID}:${PGID}`, loads `.env`.
- Container paths (`SHARED_DIR=/files/new`, `BASE_DIR=/files`, `ACTUAL_DATA_DIR=/data`) are set in `environment:` and override `.env`.
- Volumes:
  - `${HOST_FILES_DIR}` -> `/files/new` (the shared folder)
  - `./data` -> `/data` (local budget cache)
  - `./app/config.json` -> `/app/config.json` (read-only)
- `extra_hosts: host.docker.internal:host-gateway` lets the container reach the Actual server on the host, so Actual's port must be published on the host. (The alternative is joining Actual's Docker network and using `http://<actual-container-name>:5006`; this setup does not do that.)
- `stop_grace_period: 30s` lets an in-progress import finish on shutdown.
- Logs use the `json-file` driver with rotation (10 MB x 3 files).

### Processing folders live inside the container

Only `new` is a host mount. `wip/`, `complete/` and `failed/` exist only in the container's filesystem. That has consequences:

- `docker compose down`, a rebuild, or anything else that **recreates the container deletes the contents of `complete/` and `failed/`**. (`up -d --build` recreates the container when the image changes.) A plain `docker compose restart` keeps them.
- To inspect failed files:
  ```bash
  docker compose exec actual-importer ls /files/failed
  docker cp actual-importer:/files/failed ./failed-files
  ```
- Re-dropping a CSV is always safe because of the `imported_id` dedupe.
- If losing `complete/` and `failed/` becomes annoying, mount a host folder at `/files` for them instead. Be careful to keep `new` working as well (for example, mount the parent folder and have the Samba share point at its `new` subfolder).

## Day-to-day commands

```bash
docker compose up -d --build               # first start, or after changing code/package files
docker compose logs -f                     # watch activity
docker compose restart                     # after editing app/config.json
git pull && docker compose up -d --build   # update from GitHub
docker compose build --no-cache            # clean rebuild (e.g. after the Actual API version changes)
```

`git pull` alone changes nothing: the code is baked into the image, so rebuild after pulling.

## Updating

### Code changes

`git pull && docker compose up -d --build`

### Keeping the API version in sync with the Actual server

`@actual-app/api` is `latest` in `package.json` but pinned by `package-lock.json` (26.11.0 when last checked). It should match the version of the Actual server. When the server is upgraded:

```bash
cd app
npm install @actual-app/api@<server version>
cd ..
git add app/package.json app/package-lock.json && git commit -m "Bump Actual API"
docker compose build --no-cache && docker compose up -d
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `"/importer.mjs": not found` during build | `COPY` reads from the build context (the folder with `compose.yaml`), not from `WORKDIR` | Run compose from the repo folder, and make sure the `COPY` paths match the real layout (`app/...`) |
| `EACCES: permission denied, mkdir '/files/wip'` | `/files` was created root-owned and the non-root user can't create folders in it | The Dockerfile `mkdir -p`s the folders and `chmod`s them. Rebuild with `docker compose up -d --build` |
| `EXDEV: cross-device link not permitted` | `fs.rename` can't move a file from the bind-mounted share to the container's own filesystem | Already handled: `moveTo` in `importer.mjs` falls back to `copyFile` + `unlink` on `EXDEV` |
| Dropped file never processed | `skipImport: true`, a filename that doesn't contain an account name, or chokidar not seeing events on the share | Check the logs. Set `skipImport: false`. Name the file after an account. If events are being missed, try `usePolling: true` in the chokidar options |
| Edited `config.json`, no effect | It's read once at startup | `docker compose restart` |
| Edited `importer.mjs`, no effect | Code is baked into the image | `docker compose up -d --build` |
| Can't connect to Actual | `ACTUAL_SERVER_URL` uses `localhost`, or Actual's port isn't published on the host | Use `http://host.docker.internal:5006` and confirm the port mapping on the Actual container |
| File fails with a permissions error on the share | Container user can't write to `new` (moving a file out deletes it) | Match `PUID`/`PGID` to the share's owner, or adjust Samba `force user` / `create mask` |

## Caveats

- Moving a file between the share and the container is copy-then-delete, so it isn't atomic. The dedupe makes a re-run harmless.
- If the container is stopped mid-import, the file may be left in `wip/` inside the container. The script does **not** requeue it automatically; drop the CSV in `new` again.
- The service only learns about `config.json` changes on restart.
- Logs are stdout only.
