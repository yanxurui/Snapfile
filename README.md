# Snapfile

An anonymous file transfer application that enables you to access files from any device without any account


## Features
* anonymous chat room
* file transfer across any devices where a modern browswer is available
* secure:
    * E2E encryption. File contents, filenames and chat text are encrypted in
      the browser; the server receives ciphertext and a separate authentication
      token
    * expires automatically after one day


## TODO

* [ ] Address short-passcode offline guessing in a separate change: design
  high-entropy, browser-generated encryption secrets shared through URL fragments,
  with a copyable recovery code and clear key-retention/recovery behavior.
  Clearly document any future key-format and access changes.
  This sharing/access redesign is deferred from file and chat encryption;
  encryption keys must still stay out of server requests.

## Encrypted files and chat

Folders retain the familiar six-character passcode. Their files and filename
metadata use a versioned, authenticated streaming format. Uploading starts after
a small quota-admission request, without collecting the complete plaintext or
ciphertext in memory. Downloads decrypt to a File System Access writable and
commit only after the final authentication record and end of stream are verified.
There is **no whole-file Blob fallback**. Progress labels distinguish bytes
encrypted from server-confirmed completion.

Use **current desktop Chrome/Chromium or Edge, HTTPS, and browser-facing HTTP/2
(or HTTP/3)**. Direct aiohttp HTTP/1 is not sufficient for streaming fetch uploads,
even on localhost. Safari/mobile browser compatibility is not provided for this
file path.

Chat text is authenticated and encrypted in the browser with a separate
domain-separated key and a fresh nonce per message. The server stores and relays
only the opaque envelope. Messages may contain up to 65,536 UTF-8 bytes;
ciphertext envelope bytes, not a client-supplied plaintext size, count against
folder quota. Live messages and paged history are decrypted before display.
Unreadable messages show an error row without hiding later messages.

Share/QR links use `/login.html#identity=CODE`. The same short code
is in a fragment so it is not sent in HTTP requests or access logs. Do not move it
into a query string. Browser local storage retains the code, as before; logout
clears it. This change adds no recovery-code or key-retention redesign.

**Breaking change:** only browser-encrypted files and chat are supported. Pre-existing
folder records/passcodes and `?identity=...` share links are not supported, and
there is no migration or legacy login/upload/download mode. Create a new folder.
Unsupported or malformed stored records are rejected with a visible error and
left untouched by the expiry cleaner; this change does not delete old user data.
`POST /files` now accepts JSON upload admission, not multipart plaintext. Login accepts only the
browser-derived authentication token, never a raw passcode or protocol selector.
Plaintext chat clients are rejected. Earlier server-encrypted chat has no
migration/decryption fallback and appears as unreadable messages; stored data
is not rewritten or deleted by this change.

The server still learns file/message lengths, timing, sender information and
message order. Shared-key encryption does not authenticate individual senders or
protect against a malicious server replaying messages under new history indices. Short codes
can be guessed offline despite the client KDF; browser storage compromise or
maliciously modified application JavaScript can also expose keys. See
[the encryption protocols](docs/file-encryption.md) for framing, quota and format
details.

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

* Python 3.12 (pyenv recommended)
* Redis
* Node.js 18+ (for the Vue-based client build)

```sh
# 1. download source code
git clone https://github.com/yanxurui/Snapfile
cd Snapfile

# 2. build the client
cd client
npm install
npm run build
cd ..

# 3. configure the server (see server/snapfile/config.py)

# 4. install the backend package
cd server
pip install -e .

# 5. start the app (installed "snapfile" console entry point)
snapfile
```

some default configuration
* PORT: The server will listen to port 8090
* LOG_FILE: Logs are output to `test.log` in the current workding directory (i.e., CWD)
* UPLOAD_ROOT_DIRECTORY: Files are stored in `./upload` in CWD

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
This is a web app based on aiohttp (built on top of asyncio) which is an asynchronous http libaray. That means, its networking operations are non-blocking and all http requests can be processed in a concurrent manner in a single thread. So far, it's the best choice in the Python world for constructing a high performance web server.

It supports websocket (long connection) which allows to implement the instant messaging or chat very easily.

### NGINX

1. serve static files, such as html, css, etc
2. handle download efficiently
3. prevent from brute force attack
4. sharing port 443 with other services and forwarding to the backend (python web app in our case)

Streaming uploads require HTTP/2 on the **browser-facing TLS listener**. The
checked-in `deploy/snapfile.conf` uses `listen 443 ssl http2` (and the IPv6
equivalent) for older CentOS nginx. For nginx **1.25.1 or newer**, prefer
`listen 443 ssl;`, `listen [::]:443 ssl;`, and `http2 on;` in the server block.
The build must include `http_v2_module`; check `nginx -V`, validate with `nginx -t`,
and verify the browser's actual negotiated protocol after any deployment.

Ciphertext downloads use NGINX `X-Accel-Redirect` by default with `ENV=PROD`;
other environments default to aiohttp `FileResponse`. `USE_X_ACCEL_REDIRECT` is
`False` in the defaults and `True` in the PROD section of `server/snapfile/config.py`.
Set it to `False` in that section when running without NGINX. Settings are
configured in this file; only `ENV` selects the environment section.
`HOST = None` preserves binding to all interfaces in DEV/PROD; TEST/E2E bind
to `127.0.0.1`. The backend always authorizes the folder and validates file IDs first.
Enable only with the `internal` `/download/` location in `deploy/snapfile.conf`,
whose `/var/www/snapfile/files/` alias must match the backend upload root.
NGINX serves ciphertext, never plaintext: filenames remain encrypted metadata
and are decrypted only in the browser, not restored in response headers or URLs.
See [download offload](docs/file-encryption.md#optional-nginx-download-offload).

Keep `proxy_http_version 1.1` and `proxy_request_buffering off` on `/files`
and `/files/<token>`: that is the separate nginx-to-aiohttp connection.
Do not introduce a proxy/CDN that buffers the full request. The app currently
supports a **single backend process**, including its websocket cache and
quota-reservation lock; do not scale it to independent workers without shared
atomic admission/accounting and websocket coordination. Repository configuration
changes do not update a running production server automatically.

### Redis
keys:

* `#files:<folder identity>` int: the last file id in a given folder
* `folder:<folder identity>` str: meta data of a folder serialized in json format, like created time, quota, size, etc
* `messages::<folder identity>` list: messages (including file meta data) serialized in json format

### Client (Vue + Vite)

The legacy jQuery UI has been migrated to Vue 3 with Vite.

```sh
cd client

# install dependencies
npm install

# start Vite dev server with backend proxying to the Python app on :8080
npm run dev

# produce production assets into dist/ (copied to /var/www/snapfile/static by install.sh)
npm run build

# locally preview the production build
npm run preview
```

The default Vite/aiohttp HTTP/1 development path cannot exercise encrypted file
uploads. To run the built app with an isolated local TLS/H2 proxy:

```sh
cd client
SNAPFILE_E2E=1 npm run build
node tests/e2e/server.mjs
# Open https://127.0.0.1:8443/login.html in desktop Chromium.
# The generated local certificate is self-signed; no system trust is changed.
# Ctrl-C stops this launcher's Redis/backend and removes its temporary files.
```

This launcher uses private Redis/backend ports and a fresh `.cache/e2e-*`
directory. It never uses the normal Redis instance or uploads. Set `E2E_PYTHON`
if needed; a worktree `.venv/bin/python` is preferred when present.
The test-only `server/tests/run_server.py` accepts private ports and a temporary
directory from the launchers without adding environment overrides to application
config. E2E quota is fixed at 96 MiB in the E2E config section.

### Supervisord
manage the lifecycle of the service
To restart the service, run the command below as root:
```
supervisorctl restart snapfile
```

### Continuous integration & releases

GitHub Actions automate testing, building and release packaging:

* `.github/workflows/ci.yml` — runs the backend unit tests, the Playwright E2E
  suite and a client build on every pull request to `master` and every push to
  `master`. `master` is protected so changes land via PR.
* `.github/workflows/release.yml` — when you push a `v*` tag (or run it
  manually), it builds the client off-host and publishes a prebuilt
  `snapfile-<version>.tar.gz` to GitHub Releases, which `deploy/install.sh`
  installs (see *Deploy in production mode* above).

### Test

need to install packages: websocket-client

#### test_api.py
Functional test for APIs of python backend:
using the classical python unittest
```sh
cd server/tests
python -m unittest -v test_api.py
```

* starts a loopback-only, non-persistent Redis on an available private port
* starts backends on a private port with temporary uploads/logs
* tears down only its own processes and test directory; no real Redis is flushed

some known issues:

The error below was due to a bug in package requests, which re-encodes the
quoted JSON value stored in the session cookie by `SimpleCookieStorage` so the
server can no longer decode it: [Revert PR 1440, do not modify cookie value by yanxurui · Pull Request #5459 · psf/requests](https://github.com/psf/requests/pull/5459) (rejected upstream — "too ingrained to revert in 2.x").

```
json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)
```

The test client now works around this by sending the session cookie verbatim
(the same way the websocket helper does), so a patched `requests` is no longer
required. This could also be fixed permanently at the source by switching the
session middleware from `SimpleCookieStorage` to `EncryptedCookieStorage`: it
base64-encodes the cookie value, so it contains no quotes/special characters for
`requests` to mangle — fixing it for any HTTP client, not just the tests.

There might be a chance that test_api.TestExpire fails because the orphan process is cleang the data.
```
AssertionError: '1 folders found and 0 folders deleted' not found in 'xxx
```

#### test_nginx.py
Functional test for NGINX config in a production environment.

#### benchmark.py
stress test for aiohttp.

#### End-to-end tests (Playwright)
Browser-level tests drive the built Vue client through real HTTPS/HTTP2 to the
backend (plus WebSocket and isolated Redis). They cover file authentication,
bounded buffering/backpressure, disk-backed downloads, cancellation/quota cleanup,
rejection of unsupported old paths, messaging and sharing.

```sh
cd client
npm install
npx playwright install chromium   # one-time browser download
npm run test:e2e                  # builds the client, then runs the suite
npm run test:crypto               # framing, key separation and stream unit tests
```

Each run starts its own isolated, in-memory Redis and backend (`ENV=E2E`), so it
never touches your dev/prod data. `redis-server` must be on your `PATH`. See
`client/tests/e2e/README.md` for details.
