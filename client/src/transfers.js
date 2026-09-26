import { ciphertextSize, decryptFile, decryptMetadata, encryptFile } from './crypto.js';

export const BUFFERED_FILE_LIMIT = 100_000_000;

export function checkBufferedSize(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
  if (size >= BUFFERED_FILE_LIMIT) {
    throw new Error('Buffered transfers require files smaller than 100 MB (100,000,000 bytes). ' +
      'Use desktop Chrome or Edge with HTTP/2 or HTTP/3 for larger files.');
  }
}

export async function bufferEncryptedFile(file, key, { signal, onProgress } = {}) {
  checkBufferedSize(file.size);
  signal?.throwIfAborted();
  const encrypted = await encryptFile(file, key, { onProgress });
  const reader = encrypted.body.getReader();
  const chunks = [];
  let bytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(console.error); };
  try {
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > encrypted.size || bytes > ciphertextSize(BUFFERED_FILE_LIMIT - 1)) {
        throw new Error('Encrypted file exceeds the buffered transfer limit');
      }
      chunks.push(value);
    }
    if (bytes !== encrypted.size) throw new Error('Incomplete encrypted file');
    return {
      body: new Blob(chunks, { type: 'application/octet-stream' }),
      metadata: encrypted.metadata, size: encrypted.size
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    chunks.length = 0;
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
      encrypted.dispose();
    }
  }
}

export async function decryptFileToBlob(stream, metadata, key, { signal } = {}) {
  const chunks = [];
  let handedOff = false;
  let bytes = 0;
  try {
    const meta = await decryptMetadata(metadata, key);
    checkBufferedSize(meta.size);
    signal?.throwIfAborted();
    const writable = new WritableStream({
      write(chunk) {
        signal?.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > meta.size || bytes >= BUFFERED_FILE_LIMIT) {
          throw new Error('Decrypted file exceeds the buffered transfer limit');
        }
        chunks.push(chunk);
      },
      abort() { chunks.length = 0; }
    });
    handedOff = true;
    // decryptFile closes only after every record, FINAL and EOF authenticate.
    await decryptFile(stream, metadata, key, writable, { signal });
    signal?.throwIfAborted();
    return { name: meta.name, blob: new Blob(chunks, { type: 'application/octet-stream' }) };
  } finally {
    chunks.length = 0;
    if (!handedOff) await stream.cancel();
  }
}
