import { test } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { CHUNK_SIZE, credentials, encryptFile, decryptFile, decryptMetadata, ciphertextSize,
  encryptChat, decryptChat, MAX_CHAT_BYTES, MAX_CHAT_ENVELOPE } from '../src/crypto.js';

const { key, auth, chatKey } = await credentials('test-passcode');

async function encrypted(size) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37) % 251);
  const file = new File([bytes], 'original.txt');
  const result = await encryptFile(file, key);
  const wire = new Uint8Array(await new Response(result.body).arrayBuffer());
  return { ...result, bytes, wire };
}

function fragmented(bytes) {
  let offset = 0;
  let index = 0;
  const boundaries = [1, 3, 11, 31, 65536];
  return new ReadableStream({
    type: 'bytes',
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        controller.byobRequest?.respond(0);
        return;
      }
      const end = Math.min(bytes.length, offset + boundaries[index++ % boundaries.length]);
      controller.enqueue(Uint8Array.from(bytes.subarray(offset, end)));
      offset = end;
    }
  }, { highWaterMark: 0 });
}

async function decoded(wire, metadata, secret = key) {
  const chunks = [];
  let closed = false;
  let aborted = false;
  const sink = new WritableStream({
    write(bytes) { chunks.push(bytes); },
    close() { closed = true; },
    abort() { aborted = true; }
  });
  try {
    await decryptFile(fragmented(wire), metadata, secret, sink);
    assert.equal(closed, true);
    assert.equal(aborted, false);
    return Buffer.concat(chunks);
  } catch (error) {
    assert.equal(closed, false, 'failure must not commit a download');
    assert.equal(aborted, true);
    throw error;
  }
}

test('domain-separated authentication does not equal the file metadata key', async () => {
  assert.notEqual(auth, Buffer.from(key).toString('hex'));
  assert.equal(auth.length, 64);
  assert.notEqual(auth, Buffer.from(chatKey).toString('hex'));
  assert.notDeepEqual(key, chatKey);
});

test('authenticated chat preserves UTF-8, whitespace, newlines and URLs with a fresh nonce', async () => {
  const text = '  hello \u4e16\u754c \u{1f30d}\nhttps://example.com/a?b=c\n';
  const first = await encryptChat(text, chatKey);
  const second = await encryptChat(text, chatKey);
  assert.notEqual(first, second);
  assert.match(first, /^SNAPCHAT01\.[A-Za-z0-9_-]+$/);
  assert.equal(await decryptChat(first, chatKey), text);
  assert.equal(await decryptChat(second, chatKey), text);
});

test('chat rejects wrong keys, format changes, tampering, truncation and trailing bytes', async () => {
  const envelope = await encryptChat('private text', chatKey);
  for (const wrongKey of [key, sodium.from_hex(auth), (await credentials('wrong')).chatKey]) {
    await assert.rejects(decryptChat(envelope, wrongKey));
  }
  const bytes = sodium.from_base64(envelope.slice('SNAPCHAT01.'.length));
  const changedNonce = bytes.slice();
  changedNonce[0] ^= 1;
  bytes[25] ^= 1;
  const mutations = [
    'plaintext', envelope.replace('SNAPCHAT01', 'SNAPCHAT02'), envelope.slice(0, -4),
    envelope + 'AAAA', envelope + '=', 'SNAPCHAT01.' + sodium.to_base64(bytes),
    'SNAPCHAT01.' + sodium.to_base64(changedNonce),
    'SNAPCHAT01.' + 'A'.repeat(MAX_CHAT_ENVELOPE), null, {}
  ];
  for (const bad of mutations) await assert.rejects(decryptChat(bad, chatKey));
});

test('chat enforces exact UTF-8 byte and envelope limits', async () => {
  const maximum = await encryptChat('a'.repeat(MAX_CHAT_BYTES), chatKey);
  assert.equal(maximum.length, MAX_CHAT_ENVELOPE);
  assert.equal((await decryptChat(maximum, chatKey)).length, MAX_CHAT_BYTES);
  const unicode = '\u00e9'.repeat(MAX_CHAT_BYTES / 2);
  assert.equal(await decryptChat(await encryptChat(unicode, chatKey), chatKey), unicode);
  for (const invalid of ['', 'x'.repeat(MAX_CHAT_BYTES + 1), unicode + 'x', null, {}]) {
    await assert.rejects(encryptChat(invalid, chatKey));
  }
});

test('chat authenticates the format context and rejects invalid UTF-8 after authentication', async () => {
  const nonce = sodium.randombytes_buf(24);
  for (const [plaintext, domain] of [
    [new Uint8Array([0xff]), 'snapfile:chat:SNAPCHAT01'],
    [sodium.from_string('text'), 'snapfile:file-metadata:v2']
  ]) {
    const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext, sodium.from_string(domain), null, nonce, chatKey);
    const bytes = new Uint8Array(24 + encrypted.length);
    bytes.set(nonce);
    bytes.set(encrypted, 24);
    await assert.rejects(decryptChat('SNAPCHAT01.' + sodium.to_base64(bytes), chatKey));
  }
});

for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 3]) {
  test(`exact round trip, arbitrary network boundaries: ${size} bytes`, async () => {
    const data = await encrypted(size);
    assert.equal(data.wire.length, ciphertextSize(size));
    assert.deepEqual(await decoded(data.wire, data.metadata), Buffer.from(data.bytes));
    assert.equal((await decryptMetadata(data.metadata, key)).name, 'original.txt');
    assert.equal(Buffer.from(data.wire).includes(Buffer.from('original.txt')), false);
  });
}

test('reject wrong key and tampered metadata without committing', async () => {
  const data = await encrypted(100);
  const wrong = (await credentials('wrong-key')).key;
  await assert.rejects(decoded(data.wire, data.metadata, wrong));
  await assert.rejects(decoded(data.wire, data.metadata.slice(0, -5) + 'AAAAA'));
});

test('reject altered, truncated, reordered, duplicated, oversized and trailing records', async () => {
  const data = await encrypted(CHUNK_SIZE * 2 + 1);
  const length = CHUNK_SIZE + 21;
  const records = [
    data.wire.slice(32, 32 + length),
    data.wire.slice(32 + length, 32 + 2 * length),
    data.wire.slice(32 + 2 * length)
  ];
  const changed = data.wire.slice();
  changed[80] ^= 1;
  const badLength = data.wire.slice();
  new DataView(badLength.buffer).setUint32(32, 0xffffffff);
  const header = data.wire.slice();
  header[9] ^= 1;
  const cases = [
    changed, badLength, header, data.wire.slice(0, -1), data.wire.slice(0, -21),
    Buffer.concat([data.wire, Buffer.from([0])]),
    Buffer.concat([data.wire.slice(0, 32), records[1], records[0], records[2]]),
    Buffer.concat([data.wire.slice(0, 32), records[0], records[0], records[2]])
  ];
  for (const bytes of cases) await assert.rejects(decoded(bytes, data.metadata));
});

test('pull-driven encryption does not read ahead and cancels its source', async () => {
  let reads = 0;
  const file = {
    name: 'large.bin', size: 512 * CHUNK_SIZE,
    slice(start, end) {
      assert.ok(end - start <= CHUNK_SIZE);
      return { async arrayBuffer() { reads += 1; return new ArrayBuffer(end - start); } };
    }
  };
  const metrics = {};
  const encrypted = await encryptFile(file, key, { metrics });
  assert.equal(reads, 0);
  const reader = encrypted.body.getReader();
  await reader.read(); // header
  assert.equal(reads, 0);
  await reader.read();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 1);
  assert.equal(metrics.maxPlaintext, CHUNK_SIZE);
  assert.equal(metrics.maxRecord, CHUNK_SIZE + 21);
  await reader.cancel();
  encrypted.dispose(); // idempotent even after cancellation
  assert.equal(reads, 1);
});

test('decryption waits for disk writes before pulling another record', async () => {
  const data = await encrypted(CHUNK_SIZE * 3);
  let pulls = 0;
  let writes = 0;
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  let offset = 0;
  const source = new ReadableStream({
    type: 'bytes',
    pull(controller) {
      pulls += 1;
      if (offset === data.wire.length) {
        controller.close();
        controller.byobRequest?.respond(0);
        return;
      }
      const end = Math.min(offset + 65536, data.wire.length);
      controller.enqueue(data.wire.slice(offset, end));
      offset = end;
    }
  }, { highWaterMark: 0 });
  const sink = new WritableStream({ async write() { writes += 1; if (writes === 1) await gate; } });
  const result = decryptFile(source, data.metadata, key, sink);
  while (!writes) await new Promise(resolve => setTimeout(resolve, 1));
  const atPause = pulls;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pulls, atPause, 'no network pulls while destination is blocked');
  unblock();
  await result;
  assert.equal(writes, 3);
});

test('canceling a network read aborts the destination and reports cancellation', async () => {
  const data = await encrypted(CHUNK_SIZE);
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  let aborted = false;
  let committed = false;
  const source = new ReadableStream({
    type: 'bytes',
    pull() { started(); }
  });
  const sink = new WritableStream({
    abort() { aborted = true; },
    close() { committed = true; }
  });
  const operation = decryptFile(source, data.metadata, key, sink, { signal: controller.signal });
  await reading;
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(aborted, true);
  assert.equal(committed, false);
});
