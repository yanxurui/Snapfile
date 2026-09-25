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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { request as httpRequest } from 'node:http';
import { Transform } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url)); // client/tests/e2e
const repoRoot = resolve(here, '..', '..', '..');

const REDIS_PORT = process.env.E2E_REDIS_PORT || '6390';
const SNAPFILE_PORT = process.env.E2E_PORT || '8091';
const HTTPS_PORT = process.env.E2E_HTTPS_PORT || '8443';
const testRoot = resolve(repoRoot, '.cache');
mkdirSync(testRoot, { recursive: true });
const runDirectory = mkdtempSync(resolve(testRoot, 'e2e-'));
const runtimePath = resolve(testRoot, 'e2e-current.json');
let proxy;

// Pick a working interpreter: honor E2E_PYTHON, else prefer `python`, then
// `python3` (minimal Linux/CI images often only ship `python3`).
function resolvePython() {
  const candidates = [process.env.E2E_PYTHON, resolve(repoRoot, '.venv/bin/python'), 'python', 'python3'].filter(Boolean);
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
  proxy?.close();
  const finish = () => {
    rmSync(runDirectory, { recursive: true, force: true });
    rmSync(runtimePath, { force: true });
    process.exit(code);
  };
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
    if (alive.length === 0) return finish();
    if (Date.now() - start > 5000) {
      for (const c of alive) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
      return setTimeout(finish, 200);
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
for (const [name, port] of [['redis', REDIS_PORT], ['snapfile', SNAPFILE_PORT], ['https', HTTPS_PORT]]) {
  if (!(await isPortFree(port))) {
    console.error(`[e2e] port ${port} (${name}) is already in use.`);
    console.error('[e2e] a previous run may have left a process behind — free the port and retry.');
    process.exit(1);
  }
}

// 1. Ephemeral Redis ---------------------------------------------------------
const redis = spawn(
  'redis-server',
  ['--bind', '127.0.0.1', '--port', REDIS_PORT, '--save', '', '--appendonly', 'no', '--dir', runDirectory],
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
const server = spawn(PYTHON, [resolve(repoRoot, 'server/tests/run_server.py'),
  '--environment', 'E2E', '--port', SNAPFILE_PORT, '--redis-port', REDIS_PORT,
  '--directory', runDirectory], {
  cwd: resolve(repoRoot, 'server'),
  stdio: ['ignore', 'inherit', 'inherit'],
});
children.push(server);
server.on('error', (err) => fail(`failed to start snapfile test backend (${PYTHON}): ${err.message}`));
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

const keyPath = resolve(runDirectory, 'key.pem');
const certPath = resolve(runDirectory, 'cert.pem');
const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
if (certificate.status !== 0) {
  fail(`certificate generation failed: ${certificate.stderr?.toString()}`);
} else {
  const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
  function headers(input) {
    return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith(':') && !hopHeaders.has(key)));
  }
  proxy = createSecureServer({ key: readFileSync(keyPath), cert: readFileSync(certPath), allowHTTP1: true });
  proxy.on('request', (request, response) => {
    const upstream = httpRequest({
      host: '127.0.0.1', port: SNAPFILE_PORT, path: request.url, method: request.method,
      headers: headers(request.headers)
    }, (reply) => {
      response.writeHead(reply.statusCode, headers(reply.headers));
      if (request.headers['x-e2e-slow-download'] === '1') {
        const throttle = new Transform({
          transform(chunk, encoding, done) { setTimeout(() => done(null, chunk), 15); }
        });
        reply.pipe(throttle).pipe(response);
        response.on('close', () => { reply.destroy(); throttle.destroy(); });
      } else reply.pipe(response);
      reply.on('error', (error) => response.destroy(error));
    });
    upstream.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502);
      response.end('Backend connection failed');
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    if (request.headers['x-e2e-slow-upload'] === '1') {
      const throttle = new Transform({
        transform(chunk, encoding, done) { setTimeout(() => done(null, chunk), 5); }
      });
      request.pipe(throttle).pipe(upstream);
      request.on('aborted', () => throttle.destroy());
    } else request.pipe(upstream);
  });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = connect({ host: '127.0.0.1', port: SNAPFILE_PORT }, () => {
      const header = Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n');
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${header}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  proxy.on('error', (error) => fail(error.message));
  proxy.listen(Number(HTTPS_PORT), '127.0.0.1', () => {
    writeFileSync(runtimePath, JSON.stringify({ directory: runDirectory, redisPort: REDIS_PORT }));
    console.log(`[e2e] real TLS/H2 proxy on https://127.0.0.1:${HTTPS_PORT}`);
  });
}
