import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE, credentials, decryptFile, encryptFile } from '../src/crypto.js';
import { BUFFERED_FILE_LIMIT, checkBufferedSize, bufferEncryptedFile, decryptFileToBlob } from '../src/transfers.js';

const { key } = await credentials('buffered-transfer-test');

test('buffering is strictly below decimal 100 MB, checked without reading oversized inputs', async () => {
  assert.equal(BUFFERED_FILE_LIMIT, 100_000_000);
  for (const size of [0, 1, BUFFERED_FILE_LIMIT - 1]) checkBufferedSize(size);
  for (const size of [BUFFERED_FILE_LIMIT, BUFFERED_FILE_LIMIT + 1, -1, NaN, 1.5]) {
    assert.throws(() => checkBufferedSize(size));
  }
  await assert.rejects(bufferEncryptedFile({
    name: 'oversized', size: BUFFERED_FILE_LIMIT, slice() { assert.fail('must not read'); }
  }, key), /smaller than 100 MB/);

  const oversized = await encryptFile({ name: 'oversized', size: BUFFERED_FILE_LIMIT }, key);
  let canceled = false;
  const source = new ReadableStream({
    pull() { assert.fail('must not read'); }, cancel() { canceled = true; }
  }, { highWaterMark: 0 });
  await assert.rejects(decryptFileToBlob(source, oversized.metadata, key), /smaller than 100 MB/);
  assert(canceled);
  oversized.dispose();
});

test('buffered upload and streamed download use the same authenticated format', async () => {
  const bytes = new Uint8Array(CHUNK_SIZE + 7).fill(29);
  const file = new File([bytes], 'private-name.bin');
  const encrypted = await bufferEncryptedFile(file, key);
  assert(encrypted.body instanceof Blob);
  assert.equal(encrypted.body.size, encrypted.size);
  const wire = Buffer.from(await encrypted.body.arrayBuffer());
  assert.equal(wire.subarray(0, 8).toString(), 'SNAPFE02');
  assert(!wire.includes(Buffer.from(file.name)));
  const output = [];
  await decryptFile(new Response(encrypted.body).body, encrypted.metadata, key,
    new WritableStream({ write(chunk) { output.push(chunk); } }));
  assert.deepEqual(Buffer.concat(output), Buffer.from(bytes));
});

test('streamed upload can be saved as a fully authenticated Blob, including empty files', async () => {
  for (const size of [0, CHUNK_SIZE + 7]) {
    const bytes = new Uint8Array(size).fill(71);
    const encrypted = await encryptFile(new File([bytes], 'original.bin'), key);
    const response = new Response(await new Response(encrypted.body).blob());
    const result = await decryptFileToBlob(response.body, encrypted.metadata, key);
    assert.equal(result.name, 'original.bin');
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), Buffer.from(bytes));
  }
});

test('buffered downloads never return a Blob on corruption, truncation or a wrong key', async () => {
  const encrypted = await bufferEncryptedFile(new File([new Uint8Array(CHUNK_SIZE + 8)], 'bad.bin'), key);
  const bytes = new Uint8Array(await encrypted.body.arrayBuffer());
  const damaged = bytes.slice();
  damaged[CHUNK_SIZE + 60] ^= 1;
  for (const [wire, secret] of [
    [damaged, key], [bytes.slice(0, -1), key], [bytes, new Uint8Array(32)]
  ]) {
    await assert.rejects(decryptFileToBlob(new Response(wire).body, encrypted.metadata, secret));
  }
});

test('canceling buffered encryption stops slice reads and a retry succeeds', async () => {
  const controller = new AbortController();
  let reads = 0;
  const file = {
    name: 'cancel.bin', size: 3 * CHUNK_SIZE,
    slice(start, end) {
      assert(end - start <= CHUNK_SIZE);
      return { async arrayBuffer() { reads += 1; return new ArrayBuffer(end - start); } };
    }
  };
  await assert.rejects(bufferEncryptedFile(file, key, {
    signal: controller.signal, onProgress() { controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(reads, 1);
  assert.equal((await bufferEncryptedFile(new File(['retry'], 'ok'), key)).body.size, 79);
});

test('canceling a buffered download discards its authenticated prefix', async () => {
  const encrypted = await bufferEncryptedFile(new File([new Uint8Array(CHUNK_SIZE + 7)], 'cancel.bin'), key);
  const bytes = new Uint8Array(await encrypted.body.arrayBuffer());
  const controller = new AbortController();
  let offset = 0;
  const source = new ReadableStream({
    type: 'bytes',
    pull(stream) {
      if (offset >= CHUNK_SIZE + 53) {
        controller.abort();
        return;
      }
      const end = Math.min(offset + 65536, CHUNK_SIZE + 53);
      stream.enqueue(bytes.slice(offset, end));
      offset = end;
    }
  });
  await assert.rejects(decryptFileToBlob(source, encrypted.metadata, key, { signal: controller.signal }),
    { name: 'AbortError' });
});
