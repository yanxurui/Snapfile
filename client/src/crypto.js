import sodium from 'libsodium-wrappers';

export const CHUNK_SIZE = 1024 * 1024;
export const MAX_CHAT_BYTES = 64 * 1024;
const CHAT_PREFIX = 'SNAPCHAT01.';
export const MAX_CHAT_ENVELOPE = CHAT_PREFIX.length + Math.ceil((MAX_CHAT_BYTES + 40) * 4 / 3);
const MAGIC = new TextEncoder().encode('SNAPFE02');
const HEADER_SIZE = 32;
const MAX_METADATA = 16384;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const metadataDomain = encoder.encode('snapfile:file-metadata:v2');
const chatDomain = encoder.encode('snapfile:chat:SNAPCHAT01');

function freeState(state) {
  // 0.8.4 returns a WASM pointer but has no public free(); the core exports below
  // are verified against this pinned version. Wipe the state before freeing it.
  const core = sodium.libsodium;
  core.HEAPU8.fill(0, state, state + core._crypto_secretstream_xchacha20poly1305_statebytes());
  core._free(state);
}

export async function credentials(passcode) {
  await sodium.ready;
  const input = await crypto.subtle.importKey(
    'raw', encoder.encode(passcode.trim().toLowerCase()), 'PBKDF2', false, ['deriveBits']
  );
  const master = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', iterations: 310000,
    salt: encoder.encode('snapfile:passcode:v2')
  }, input, 256));
  try {
    return {
      auth: sodium.to_hex(sodium.crypto_generichash(32, encoder.encode('authentication'), master)),
      key: sodium.crypto_generichash(32, encoder.encode('file-metadata'), master),
      chatKey: sodium.crypto_generichash(32, encoder.encode('chat-message:v1'), master)
    };
  } finally {
    sodium.memzero(master);
  }
}

export async function encryptChat(text, key) {
  await sodium.ready;
  if (typeof text !== 'string' || !text.length || text.length > MAX_CHAT_BYTES) {
    throw new Error('Chat messages must contain 1 to 65536 UTF-8 bytes');
  }
  const plaintext = encoder.encode(text);
  if (plaintext.length > MAX_CHAT_BYTES) throw new Error('Chat messages cannot exceed 65536 UTF-8 bytes');
  const nonce = sodium.randombytes_buf(24);
  return CHAT_PREFIX + sodium.to_base64(join(nonce,
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, chatDomain, null, nonce, key)));
}

export async function decryptChat(envelope, key) {
  await sodium.ready;
  if (typeof envelope !== 'string' || envelope.length > MAX_CHAT_ENVELOPE ||
      !envelope.startsWith(CHAT_PREFIX)) throw new Error('Invalid encrypted chat format');
  const encoded = envelope.slice(CHAT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid encrypted chat encoding');
  const bytes = sodium.from_base64(encoded);
  if (bytes.length < 41 || bytes.length > MAX_CHAT_BYTES + 40 ||
      sodium.to_base64(bytes) !== encoded) throw new Error('Invalid encrypted chat length or encoding');
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, bytes.subarray(24), chatDomain, bytes.subarray(0, 24), key
  );
  return decoder.decode(plaintext);
}

export async function randomPasscode() {
  await sodium.ready;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 6 }, () => alphabet[sodium.randombytes_uniform(36)]).join('');
}

function join(...arrays) {
  const result = new Uint8Array(arrays.reduce((total, a) => total + a.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

export function ciphertextSize(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
  const length = HEADER_SIZE + size + 21 * (Math.ceil(size / CHUNK_SIZE) + 1);
  if (!Number.isSafeInteger(length)) throw new Error('File too large');
  return length;
}

function encryptMetadata(value, key) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > MAX_METADATA) throw new Error('Filename metadata too large');
  const nonce = sodium.randombytes_buf(24);
  return sodium.to_base64(join(nonce,
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes, metadataDomain, null, nonce, key)));
}

export async function decryptMetadata(value, key) {
  await sodium.ready;
  if (typeof value !== 'string' || value.length > 24000) throw new Error('Invalid file metadata');
  const bytes = sodium.from_base64(value);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, bytes.subarray(24), metadataDomain, bytes.subarray(0, 24), key
  );
  const meta = JSON.parse(decoder.decode(plaintext));
  if (meta.v !== 2 || typeof meta.name !== 'string' || !meta.name ||
      !Number.isSafeInteger(meta.size) || meta.size < 0 ||
      sodium.from_base64(meta.key).length !== 32 || sodium.from_base64(meta.header).length !== 24) {
    throw new Error('Invalid file metadata');
  }
  return meta;
}

export async function encryptFile(file, key, { onProgress = () => {}, metrics = {} } = {}) {
  await sodium.ready;
  const size = ciphertextSize(file.size);
  const fileKey = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  let freed = false;
  const cleanup = () => {
    if (!freed) {
      freed = true;
      freeState(state);
      sodium.memzero(fileKey);
    }
  };
  let metadata;
  try {
    metadata = encryptMetadata({
      v: 2, name: file.name, size: file.size,
      key: sodium.to_base64(fileKey), header: sodium.to_base64(header)
    }, key);
  } catch (error) {
    cleanup();
    throw error;
  }
  const envelope = join(MAGIC, header);
  const ad = join(envelope, sodium.crypto_generichash(32, encoder.encode(metadata)));
  let offset = 0;
  let started = false;
  Object.assign(metrics, { produced: 0, maxPlaintext: 0, maxRecord: 0, records: 0 });
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(envelope);
          return;
        }
        const final = offset === file.size;
        const plaintext = final ? new Uint8Array(0) :
          new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
        if (freed) return;
        const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(
          state, plaintext, ad, final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL :
            sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        );
        const frame = new Uint8Array(4 + ciphertext.length);
        new DataView(frame.buffer).setUint32(0, ciphertext.length);
        frame.set(ciphertext, 4);
        offset += plaintext.length;
        metrics.produced = offset;
        metrics.maxPlaintext = Math.max(metrics.maxPlaintext, plaintext.length);
        metrics.maxRecord = Math.max(metrics.maxRecord, frame.length);
        metrics.records += 1;
        controller.enqueue(frame);
        onProgress(offset);
        if (final) {
          cleanup();
          controller.close();
        }
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    cancel: cleanup
  }, { highWaterMark: 0 });
  return { body, metadata, size, dispose: cleanup };
}

// Copy into one bounded record buffer rather than concatenating network chunks.
class RecordReader {
  constructor(stream, metrics) {
    this.reader = stream.getReader({ mode: 'byob' });
    this.pending = new Uint8Array(0);
    this.metrics = metrics;
  }

  async exact(size, allowEnd = false) {
    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (!this.pending.length) {
        const { value, done } = await this.reader.read(new Uint8Array(64 * 1024));
        if (done) {
          if (allowEnd && offset === 0) return null;
          throw new Error('Truncated encrypted file');
        }
        this.pending = value;
      }
      const count = Math.min(size - offset, this.pending.length);
      output.set(this.pending.subarray(0, count), offset);
      this.pending = this.pending.subarray(count);
      offset += count;
      this.metrics.maxBuffered = Math.max(this.metrics.maxBuffered, size + this.pending.length);
    }
    return output;
  }
}

export async function decryptFile(stream, metadata, key, writable, { signal, metrics = {} } = {}) {
  await sodium.ready;
  let state;
  let input;
  let writer;
  let fileKey;
  let abort;
  try {
    writer = writable.getWriter();
    input = new RecordReader(stream, metrics);
    const meta = await decryptMetadata(metadata, key);
    metrics.maxBuffered = 0;
    metrics.written = 0;
    abort = () => { void input.reader.cancel(signal.reason).catch(console.error); };
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    const envelope = await input.exact(HEADER_SIZE);
    if (!sodium.memcmp(envelope.subarray(0, 8), MAGIC) ||
        !sodium.memcmp(envelope.subarray(8), sodium.from_base64(meta.header))) {
      throw new Error('Invalid encrypted file header');
    }
    fileKey = sodium.from_base64(meta.key);
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(envelope.subarray(8), fileKey);
    const ad = join(envelope, sodium.crypto_generichash(32, encoder.encode(metadata)));
    while (true) {
      signal?.throwIfAborted();
      const prefix = await input.exact(4);
      const length = new DataView(prefix.buffer).getUint32(0);
      if (length < 17 || length > CHUNK_SIZE + 17) throw new Error('Invalid encrypted record length');
      const record = await input.exact(length);
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, record, ad);
      if (!result) throw new Error('Encrypted file authentication failed');
      if (result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        if (result.message.length || metrics.written !== meta.size) throw new Error('Invalid final record');
        if (await input.exact(1, true)) throw new Error('Trailing encrypted file data');
        signal?.throwIfAborted();
        await writer.close();
        return meta;
      }
      const expected = Math.min(CHUNK_SIZE, meta.size - metrics.written);
      if (result.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE ||
          expected <= 0 || result.message.length !== expected) throw new Error('Invalid encrypted record');
      await writer.write(result.message);
      metrics.written += result.message.length;
    }
  } catch (error) {
    if (writer) await writer.abort(error);
    throw signal?.aborted ? signal.reason : error;
  } finally {
    if (state !== undefined) freeState(state);
    if (fileKey) sodium.memzero(fileKey);
    if (abort) signal?.removeEventListener('abort', abort);
    if (input) {
      await input.reader.cancel();
      input.reader.releaseLock();
    }
    writer?.releaseLock();
  }
}
