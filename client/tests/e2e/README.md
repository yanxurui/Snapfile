# End-to-end tests (Playwright)

These tests drive a real Chromium browser against the **built client through a
local TLS/HTTP2 proxy to the real aiohttp backend**, exercising encrypted file
upload/download, browser-encrypted WebSocket chat and an isolated Redis. Browser CDP asserts
the streamed upload actually negotiated `h2`, and the page asserts a secure
context. No flag bypasses Chromium's streaming-request transport requirement.

They complement the backend unit tests in `server/tests/` (which test the API
in isolation) by covering the browser/UI behaviour and the integration between
the Vue client and the Python server.

## What is covered

| Spec | Scenarios |
| --- | --- |
| `login.spec.js` | create a new folder, open an existing folder by passcode, wrong-passcode error, logout, redirect-to-login when unauthenticated |
| `messaging.spec.js` | encrypted button/Enter sends; two-context live chat and fragment key recovery; Unicode/newlines/links; actual WS frames and Redis contain ciphertext only; ordered rapid sends, paged history and reconnect dedup; wrong-key/tampered/malformed messages have visible error rows and later valid messages survive; plaintext clients rejected; UTF-8 limits and quota reservations |
| `files.spec.js` | file display/size, multifile upload, admission rejection, authenticated disk-backed download and picker user activation |
| `sharing.spec.js` | Share copies a short-passcode fragment invite and shows a QR; fresh-browser access recovers encryption keys |
| `encryption.spec.js` | actual h2; ciphertext-only file storage/metadata; empty/boundary/multichunk round trips; wrong keys, corruption, truncation, reordering/trailing data; rejection of old query links and multipart clients; token-only auth without protocol negotiation; no Blob fallback; UI upload/download cancellation; measured 64 MiB backpressure and a completed exact-byte 32 MiB disk round trip |

The native OS file picker is not automated by Playwright. Its function is
substituted with a real Origin Private File System file handle. The production
download click handler still runs (and is checked for user activation), calls
`createWritable()`, and decrypts through the same code into a real
`FileSystemWritableFileStream`. Tests verify destination bytes and that a failed
or canceled download preserves an existing destination. This is **not** a test
of the native picker UI, nor a mock/in-memory destination.

Buffer measurements instrument plaintext/record/parser sizes and network
read-ahead under a throttled real HTTP2 connection. They demonstrate early
server writes and backpressure; they do **not** measure whole-browser RSS.

Deliberately not covered: drag-and-drop upload (a secondary entry point that is
awkward to simulate reliably in Playwright — uploads are tested via the file
input) and Windows (the launcher is POSIX-only; the app is deployed on Linux).

## How it works

A run is **fully isolated** and touches none of your dev/prod data:

1. `server.mjs` (started by Playwright's `webServer`) boots loopback-only Redis
   on `6390` without persistence and a backend on `8091` in `ENV=E2E`. Its
   upload/log directory is unique under the worktree's `.cache/e2e-*`; the E2E
   quota is 96 MiB. It refuses to reuse occupied ports.
2. The backend serves the freshly built client from `client/dist`, so the tests
   run against the current UI.
3. The launcher generates a temporary self-signed certificate with OpenSSL and
   exposes `https://127.0.0.1:8443` using Node's HTTP2 TLS server. HTTP1 upgrade
   forwarding supports WebSocket. Playwright accepts the certificate only in its
   test context; no machine trust store is changed.
4. On teardown the launcher signals and waits for its own child processes,
   escalating if necessary, and removes only its generated directory.

`SNAPFILE_E2E=1` adds an extra built test-harness page that imports the same
streaming crypto module for instrumentation. Ordinary production builds do not
include that page. Test-only throttling lives in the local proxy, not the backend.
The E2E config hardcodes the 96 MiB quota and leaves `USE_X_ACCEL_REDIRECT=False`:
the Node proxy does not implement NGINX internal redirects. Private ports and
temporary paths are passed as arguments to `server/tests/run_server.py`, which
overrides those settings only inside its test process. These browser tests exercise
the aiohttp ciphertext-download fallback, not native NGINX offload. The backend
suite checks both flag settings and runs an isolated NGINX round trip when the
`nginx` executable is available (otherwise that integration test is skipped).

## Prerequisites

- Node.js 20+ and `npm install` (installs `@playwright/test`).
- OpenSSL for temporary local certificates.
- The Chromium browser for Playwright — install once:
  ```sh
  npx playwright install chromium
  ```
- `redis-server` on your `PATH` (e.g. `brew install redis`). No running Redis
  instance is required — the suite starts its own. `redis-cli` (included with
  Redis) inspects and corrupts only that isolated instance in chat tests.
- The Python backend installed (`cd server && pip install -e .`) so
  `python -m snapfile` is importable.

## Running

From the `client/` directory:

```sh
npm run test:e2e          # build the client, then run all tests (headless)
npm run test:e2e:headed   # ...with a visible browser
npm run test:e2e:ui       # ...in Playwright's interactive UI mode
npm run test:e2e:report   # open the HTML report from the last run
```

To run a single spec or filter by title:

```sh
npx playwright test files.spec.js
npx playwright test -g "download"
```

> `npm run test:e2e` rebuilds the client first so the tests always run against
> your latest source. If you run `npx playwright test` directly, build the
> client yourself (`SNAPFILE_E2E=1 npm run build`) beforehand.

## Headless vs. watching the browser

The browser is **headless by default** — `npm run test:e2e` runs `playwright
test`, which shows no window. To watch it run:

```sh
npm run test:e2e:headed   # visible Chromium window, tests run one at a time
npm run test:e2e:ui       # Playwright UI mode — watch, time-travel, re-run individual tests
```

Or ad hoc: `npx playwright test --headed` (add `--debug` for the step-through
inspector, or `-g "download"` to focus a single test). After any run,
`npm run test:e2e:report` opens the HTML report with traces/videos for failures.

## Tuning

- `E2E_PORT` / `E2E_REDIS_PORT` / `E2E_HTTPS_PORT` change the backend / Redis /
  browser-facing TLS ports.
- `E2E_PYTHON` selects the Python interpreter the launcher uses (defaults to
  the worktree's `.venv/bin/python` when present, then `python`/`python3`).

The backend API suite now starts its own private Redis too; do not run any
production nginx tests as part of local validation. Pure crypto tests are
`npm run test:crypto`.
