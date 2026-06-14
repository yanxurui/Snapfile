# Snapfile

An anonymous file transfer application that enables you to access files from any device without any account


## Features
* anonymous chat room
* file transfer across any devices where a modern browswer is available
* secure:
    * all user data (messages and files) will be encrypted. Since passcode is never persisted in the server side, no one except the owner can decrypt the data
    * expires automatically after one day


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
    |   |   `-- server   (backend source, pip-installed)
    |   `-- v1.1.0
    |       |-- static
    |       `-- server
    |-- current -> releases/v1.1.0
    |-- static  -> current/static    (NGINX root)
    |-- files   (uploads — shared across versions)
    |-- db       (redis)
    `-- logs
```

> The first run also installs prerequisites (nginx/redis/supervisor), creates the
> directories, and sets up the redis/nginx/supervisor config (it won't clobber an
> existing nginx config, so local customizations are preserved). In production
> (`ENV=PROD`) NGINX serves the static files; the Python backend only serves the
> APIs and websocket.


## Development

### AIOHttp
This is a web app based on aiohttp (built on top of asyncio) which is an asynchronous http libaray. That means, its networking operations are non-blocking and all http requests can be processed in a concurrent manner in a single thread. So far, it's the best choice in the Python world for constructing a high performance web server.

It supports websocket (long connection) which allows to implement the instant messaging or chat very easily.

### NGINX

1. serve static files, such as html, css, etc
2. handle download efficiently
3. prevent from brute force attack
4. sharing port 443 with other services and forwarding to the backend (python web app in our case)

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
cd tests
python -m unittest -v test_api.py
```

* use a separate port 8090
* select db 0 of Redis
* clean all data at startup

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
Browser-level tests that drive the built Vue client against the real backend
(HTTP + WebSocket + Redis), covering creating/opening a folder, sending
messages, uploading and downloading files, real-time sync and sharing.

```sh
cd client
npm install
npx playwright install chromium   # one-time browser download
npm run test:e2e                  # builds the client, then runs the suite
```

Each run starts its own isolated, in-memory Redis and backend (`ENV=E2E`), so it
never touches your dev/prod data. `redis-server` must be on your `PATH`. See
`client/tests/e2e/README.md` for details.
