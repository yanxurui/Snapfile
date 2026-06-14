# End-to-end tests (Playwright)

These tests drive a real Chromium browser against the **production-built client
served by the real aiohttp backend**, exercising the full stack — HTTP,
WebSocket messaging, file upload/download (including the server-side
encrypt/decrypt round trip) and Redis — the same way a user would.

They complement the backend unit tests in `server/tests/` (which test the API
in isolation) by covering the browser/UI behaviour and the integration between
the Vue client and the Python server.

## What is covered

| Spec | Scenarios |
| --- | --- |
| `login.spec.js` | create a new folder, open an existing folder by passcode, wrong-passcode error, logout, redirect-to-login when unauthenticated |
| `messaging.spec.js` | send a message (button & Enter key), messages persist across reload, real-time sync between two clients in the same folder |
| `files.spec.js` | upload a file (appears with its size), KB-scaled size formatting, multi-file upload, over-quota rejection, download a file and verify the original bytes |
| `sharing.spec.js` | Share copies an invite link to the clipboard and shows a QR code; opening the invite link auto-logs into the same folder |

Deliberately not covered: drag-and-drop upload (a secondary entry point that is
awkward to simulate reliably in Playwright — uploads are tested via the file
input) and Windows (the launcher is POSIX-only; the app is deployed on Linux).

## How it works

A run is **fully isolated** and touches none of your dev/prod data:

1. `server.mjs` in this directory (started automatically by Playwright's `webServer`)
   boots an ephemeral, in-memory Redis on a private port (`6390`, no
   persistence) and the snapfile backend in `ENV=E2E` mode (port `8091`, its own
   `upload_e2e/` directory and `e2e.log`). See the `E2E` branch in
   `server/snapfile/config.py`.
2. The backend serves the freshly built client from `client/dist`, so the tests
   run against the current UI.
3. On teardown Playwright kills the whole process group, so Redis and the server
   are cleaned up automatically.

## Prerequisites

- Node.js 18–22 and `npm install` (installs `@playwright/test`).
- The Chromium browser for Playwright — install once:
  ```sh
  npx playwright install chromium
  ```
- `redis-server` on your `PATH` (e.g. `brew install redis`). No running Redis
  instance is required — the suite starts its own.
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
> client yourself (`npm run build`) beforehand.

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

- `E2E_PORT` / `E2E_REDIS_PORT` change the backend / Redis ports.
- `E2E_PYTHON` selects the Python interpreter the launcher uses (defaults to
  `python`).
