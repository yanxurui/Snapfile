#!/usr/bin/env node
/**
 * End-to-end test server launcher (started by Playwright's `webServer`).
 *
 * Boots a fully isolated backend for the Playwright suite:
 *   1. an ephemeral, in-memory Redis on a private port (no persistence, so it
 *      never touches the developer's real Redis or leaves a dump.rdb behind);
 *   2. the snapfile aiohttp server in `ENV=E2E` mode pointed at that Redis,
 *      with its own upload directory and log file.
 *
 * Playwright starts this via `webServer.command` and signals it on teardown; we
 * wait for both children to actually exit (escalating to SIGKILL) so neither
 * Redis nor the backend is ever orphaned holding its port. POSIX-only: it
 * relies on SIGTERM/SIGINT and is intended for macOS/Linux/CI (the project is
 * deployed on Linux).
 */
import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // client/tests/e2e
const repoRoot = resolve(here, '..', '..', '..');

const REDIS_PORT = process.env.E2E_REDIS_PORT || '6390';
const SNAPFILE_PORT = process.env.E2E_PORT || '8091';

// Pick a working interpreter: honor E2E_PYTHON, else prefer `python`, then
// `python3` (minimal Linux/CI images often only ship `python3`).
function resolvePython() {
  const candidates = [process.env.E2E_PYTHON, 'python', 'python3'].filter(Boolean);
  for (const cand of candidates) {
    const probe = spawnSync(cand, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return cand;
  }
  return candidates[0] || 'python';
}
const PYTHON = resolvePython();

const children = [];
let shuttingDown = false;

const isAlive = (c) => c && c.pid && c.exitCode === null && c.signalCode === null;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (isAlive(c)) {
      try { c.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
  // Wait for the children to really exit before we do, so we never orphan a
  // process still bound to :6390 / :8091 (which would break the next run).
  const start = Date.now();
  const tick = () => {
    const alive = children.filter(isAlive);
    if (alive.length === 0) return process.exit(code);
    if (Date.now() - start > 5000) {
      for (const c of alive) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
      return setTimeout(() => process.exit(code), 200);
    }
    setTimeout(tick, 100);
  };
  tick();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

function fail(message) {
  console.error(`[e2e] ${message}`);
  shutdown(1);
}

function isPortFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(Number(port), '127.0.0.1');
  });
}

function waitForPort(port, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port: Number(port) }, () => {
        socket.end();
        res();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) rej(new Error(`timed out waiting for port ${port}`));
        else setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

// Preflight: fail fast (and clearly) if a previous run or another service is
// holding our ports, instead of letting Playwright time out cryptically.
for (const [name, port] of [['redis', REDIS_PORT], ['snapfile', SNAPFILE_PORT]]) {
  if (!(await isPortFree(port))) {
    console.error(`[e2e] port ${port} (${name}) is already in use.`);
    console.error('[e2e] a previous run may have left a process behind — free the port and retry.');
    process.exit(1);
  }
}

// 1. Ephemeral Redis ---------------------------------------------------------
const redis = spawn(
  'redis-server',
  ['--port', REDIS_PORT, '--save', '', '--appendonly', 'no'],
  { stdio: ['ignore', 'ignore', 'inherit'] }
);
children.push(redis);
redis.on('error', (err) => {
  console.error(`[e2e] failed to start redis-server: ${err.message}`);
  console.error('[e2e] is redis installed and on PATH? (e.g. `brew install redis`)');
  process.exit(1);
});
redis.on('exit', (code, signal) => {
  if (!shuttingDown) fail(`redis exited unexpectedly (code=${code}, signal=${signal})`);
});

try {
  await waitForPort(REDIS_PORT);
} catch (err) {
  fail(err.message);
}

// 2. snapfile backend --------------------------------------------------------
const server = spawn(PYTHON, ['-m', 'snapfile'], {
  cwd: resolve(repoRoot, 'server'),
  env: {
    ...process.env,
    ENV: 'E2E',
    SNAPFILE_PORT,
    REDIS_ADDRESS: `redis://127.0.0.1:${REDIS_PORT}`,
    SNAPFILE_UPLOAD: resolve(repoRoot, 'upload_e2e'),
    SNAPFILE_LOG: resolve(repoRoot, 'e2e.log'),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
children.push(server);
server.on('error', (err) => fail(`failed to start snapfile (${PYTHON} -m snapfile): ${err.message}`));
server.on('exit', (code, signal) => {
  if (!shuttingDown) fail(`snapfile exited (code=${code}, signal=${signal})`);
});

// Gate on the backend actually binding, so a startup failure is reported here
// rather than as a 60s Playwright url timeout.
try {
  await waitForPort(SNAPFILE_PORT, { timeoutMs: 30000 });
} catch (err) {
  fail(`backend did not come up on :${SNAPFILE_PORT} — ${err.message}`);
}

console.log(`[e2e] redis on :${REDIS_PORT}, snapfile on :${SNAPFILE_PORT} (python=${PYTHON})`);
