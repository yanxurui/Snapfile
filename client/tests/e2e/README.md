# Browser tests (Playwright)

Chromium drives Vue through TLS/H2 to aiohttp and private Redis. WebKit also runs
startup cases. `files.spec.js` covers file UI;
`encryption.spec.js` covers browser/storage/streaming integration.
Format, boundary and tamper matrices belong in [crypto.test.js](../crypto.test.js).
See the [encryption guide](../../../docs/file-encryption.md) for protocol details.

## Setup and commands

Complete the [project setup](../../../README.md#install--run) first. On macOS/Linux,
ensure `redis-server`, `redis-cli` and OpenSSL are on `PATH`. From `client/`:

```sh
npx playwright install chromium webkit # one-time browser installation
npm run test:e2e                      # builds current sources, then runs headless
npm run test:e2e:headed                # same suite in a visible browser
npm run test:e2e:ui                    # interactive Playwright UI
npm run test:e2e -- files.spec.js -g "download"  # build and run a selected test
npm run build                        # restore production assets after tests
```

The test build includes an instrumentation page; ordinary builds exclude it.
For direct `npx playwright test` runs, first build with `SNAPFILE_E2E=1 npm run build`.

## Manual testing

From `client/`, without starting automated tests:

```sh
npm run build
node tests/e2e/server.mjs
```

Open `https://127.0.0.1:8443/login.html` in desktop Chrome/Chromium or Edge.
The temporary certificate is self-signed; accept it only for local testing, not
in the system trust store. The native save picker remains available. Ctrl-C stops
the server and discards its test data.

## Isolation and configuration

The launcher starts nonpersistent Redis on `6390`, aiohttp on `8091` and TLS/H2
on `8443`. Uploads/logs/certificates live in a unique `.cache/e2e-*` directory;
the runtime manifest is `.cache/e2e-<HTTPS port>.json`. Teardown removes only
that run's resources. The E2E folder quota is 96 MiB, including encryption
overhead, chat and reservations (normal default: 1 GB).

`E2E_PORT`, `E2E_REDIS_PORT` and `E2E_HTTPS_PORT` select alternative ports;
use distinct ports while a manual instance is running. `E2E_PYTHON` selects the
interpreter (otherwise `.venv/bin/python`, then `python`/`python3`).

The launcher runs `python -m snapfile` with `ENV=E2E`. `config.py` accepts
`SNAPFILE_PORT`, `REDIS_ADDRESS`, `SNAPFILE_UPLOAD` and `SNAPFILE_LOG` overrides
only in TEST/E2E. Those sections also accept `SNAPFILE_USE_X_ACCEL_REDIRECT=0|1`
for offload tests; the browser launcher always sets `0`. DEV/PROD are unaffected.

## Coverage boundaries

- Tests assert secure context and actual `h2`; they do not bypass streaming
  transport requirements or change system certificate trust.
- Automated downloads substitute the native picker with an OPFS handle, but
  use real disk-backed `FileSystemWritableFileStream` writes. They test bytes and
  failure/cancellation safety, not the native picker dialog or drag-and-drop UI.
- The Node proxy exercises aiohttp downloads, not NGINX X-Accel. The backend
  suite has an optional native NGINX test, skipped when NGINX is unavailable.
- Buffer/backpressure checks measure the stream pipeline, not whole-browser RSS.
