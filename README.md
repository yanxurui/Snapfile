# Snapfile

Anonymous chat and file sharing without accounts.


## Features
* Browser-encrypted chat, file contents and filenames.
* Streaming file transfers and passcode/share-link access.
* Folders expire automatically after one day.

File transfers require **current desktop Chrome/Chromium or Edge, HTTPS and
browser-facing HTTP/2 or HTTP/3**. Short passcodes remain vulnerable to offline
guessing. See [encryption and security limits](docs/file-encryption.md) for details.

**Breaking change:** existing folders/passcodes, query-string share links and
multipart clients are unsupported. Create a new folder; stored data is not
automatically migrated or deleted.

## TODO

* [ ] Design high-entropy, browser-generated sharing secrets with fragment links,
  a copyable recovery code and clear key-retention/recovery behavior. Document
  access/key-format changes and keep encryption keys out of server requests.

## Install & Run

### Project layout

```
Snapfile/
├── client/          # Vue 3 + Vite single-page app
├── server/          # Python backend (setup.py, snapfile/, tests/)
├── deploy/          # Production configuration & install script
├── docs/            # Design notes, changelog, etc.
```

### Getting started quickly
Prerequisites

* Python 3.12+ (pyenv recommended)
* Redis
* Node.js 20+

```sh
# 1. download source code
git clone https://github.com/yanxurui/Snapfile
cd Snapfile

# 2. build the client
cd client
npm ci
npm run build
cd ..

# 3. configure the server (see server/snapfile/config.py)

# 4. install the backend package
cd server
pip install -e .

# 5. start the app (installed "snapfile" console entry point)
snapfile
```

Settings live in `server/snapfile/config.py`; `ENV` selects a section. DEV defaults
to port 8090, local Redis, console logs and `./upload` relative to the working
directory. Start Redis before the backend. Direct aiohttp HTTP/1 cannot stream
file uploads; use the local TLS/H2 launcher linked under [Tests](#tests).

### Deploy in production mode (CentOS)

The client is **built off-host by CI** and shipped as a prebuilt, versioned
release artifact, so the production server never needs Node/Vite (important on
older hosts, e.g. CentOS 7, whose glibc can't run Node 18+).

**Cut a version:** push a tag `vX.Y.Z` (or run the *Release* workflow manually).
CI builds the client and publishes `snapfile-vX.Y.Z.tar.gz` (prebuilt `static/` +
backend `server/`) to GitHub Releases.

**Deploy on the server** with the single script (edit `user`/`prefix`/`pyversion`/
`REPO` at the top of `deploy/install.sh` for your host):
```sh
cd Snapfile/deploy
sudo bash install.sh vX.Y.Z     # download the release, install, atomic switch, restart
sudo bash install.sh rollback   # instant rollback to the previous release
sudo bash install.sh list       # show installed releases and the active one
```

Each version installs under `$prefix/releases/<version>`, and a `current` symlink
selects the active one, so switching versions (and rolling back) is a single
atomic symlink flip:
```
`-- snapfile
    |-- releases
    |   |-- v1.0.0
    |   |   |-- static   (prebuilt Vue client, served by NGINX)
    |   |   |-- server   (backend source, pip-installed)
    |   |   `-- deploy   (nginx/supervisor configs for this version)
    |   `-- v1.1.0
    |       |-- static
    |       |-- server
    |       `-- deploy
    |-- current -> releases/v1.1.0
    |-- static  -> current/static    (NGINX root)
    |-- files   (uploads — shared across versions)
    |-- db       (redis)
    `-- logs
```

> The nginx/supervisor configs are **versioned with each release** (`deploy/` in
> the artifact). On every deploy/rollback the installer repoints
> `/etc/nginx/conf.d/snapfile.conf` and `/etc/supervisord.d/snapfile.ini` at the
> active release's configs, runs `nginx -t` and reloads (restoring the previous
> config if the test fails), and `supervisorctl reread && update`. So config
> changes ship through the repo like everything else. Host-specific tweaks (e.g.
> the shared `$connection_upgrade` map) live in `deploy/snapfile.conf`. The first
> run also installs prerequisites and creates the directories. In production
> (`ENV=PROD`) NGINX serves the static files; the backend only serves the APIs
> and websocket.


## Development

### AIOHttp
The asyncio-based backend handles HTTP and WebSocket chat. Run a single backend
process: folder caches, broadcasts and quota reservations are coordinated in-process.

### NGINX

`deploy/snapfile.conf` handles TLS/H2, static files, rate limiting, WebSocket
proxying and unbuffered uploads. Production enables `USE_X_ACCEL_REDIRECT` for
ciphertext downloads; disable it in the PROD config section without NGINX.
See [offload configuration](docs/file-encryption.md#optional-nginx-download-offload)
before enabling it. Repository edits alone do not update a running deployment.

### Redis
keys:

* `#files:<folder identity>` int: the last file id in a given folder
* `folder:<folder identity>` str: meta data of a folder serialized in json format, like created time, quota, size, etc
* `messages::<folder identity>` list: messages (including file meta data) serialized in json format

### Client (Vue + Vite)

```sh
cd client
npm run dev       # hot reload; proxy expects the backend on :8080
npm run preview   # preview the built client
```

Match the backend port to the proxy in `client/vite.config.js` for hot reload.

### Supervisord
manage the lifecycle of the service
To restart the service, run the command below as root:
```
supervisorctl restart snapfile
```

### Continuous integration & releases

GitHub Actions automate testing, building and release packaging:

* `.github/workflows/ci.yml` runs backend, crypto and browser tests plus a client
  build on pull requests and pushes to `master`.
* `.github/workflows/release.yml` publishes the versioned artifacts described
  under [deployment](#deploy-in-production-mode-centos).

### Tests

From the repository root:
```sh
python -m pip install requests websocket-client
(cd server/tests && python -m unittest -v test_api.py)
(cd client && npm run test:crypto)
```

The backend suite starts private, nonpersistent Redis and temporary uploads/logs,
then cleans up only its own resources. Its cookie helper works around
[requests' cookie quoting issue](https://github.com/psf/requests/pull/5459);
no patched dependency is needed.

See [browser tests and manual TLS/H2 setup](client/tests/e2e/README.md) for
Playwright prerequisites and commands. `server/tests/test_nginx.py` targets a
live deployment, not local regression testing; `benchmark.py` is a stress tool.
