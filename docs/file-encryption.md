# Browser encryption: files v2 and chat v1

## Scope and access

Browser-encrypted files and chat are the only supported application path.
This is a breaking change: pre-existing folder records,
passcodes and query share links have no compatibility or migration path. Users
must create a new folder. Old data is not deleted or reinterpreted.

Persisted folders must explicitly declare `file_format: "SNAPFE02"` and pass
schema validation. Unsupported/versionless/malformed records produce a visible
login error and are skipped by the expiry cleaner with a warning, without
rewriting or deleting their records or files. This storage marker and the
authenticated ciphertext version identify formats, not selectable app protocols.
`SNAPFE02` means Snapfile File Encryption format 02: the current secretstream
layout. It is not an encryption on/off switch or a legacy compatibility mode.

The browser normalizes the existing short passcode to lowercase and derives a
32-byte master using PBKDF2-HMAC-SHA256, 310,000 iterations, salt
`snapfile:passcode:v2`. Keyed BLAKE2b derives independent 32-byte values with
`authentication`, `file-metadata` and `chat-message:v1` labels. Only the authentication value
(hex encoded) is sent to signup/login; there is no protocol negotiation. The server
identifies folders by `SHA256(authentication)`. It cannot derive the
file or chat keys directly from that token, but it **can guess short passcodes offline**.
The KDF does not turn a six-character code into a high-entropy secret.

Share links put the same passcode in `#identity=...`, never in a query.
The login page reads only fragment invites, with no special handling for old links.
Authentication failures never send the raw passcode as a fallback. Local storage
retains only the passcode; it does not select an application protocol.

## Chat envelope and history

Chat uses the pinned libsodium XChaCha20-Poly1305 AEAD, independently of file
secretstream keys and the filename-metadata key. Every message gets a fresh
cryptographically random 24-byte nonce. Associated data is the UTF-8 string
`snapfile:chat:SNAPCHAT01`. The ASCII envelope is:

`SNAPCHAT01.` followed by canonical, unpadded base64url of
`nonce || ciphertext || 16-byte authentication tag`.

Plaintext must contain 1 through 65,536 UTF-8 bytes; the maximum envelope is
87,445 ASCII bytes. The server enforces the prefix, canonical encoding and
decoded length (41 through 65,576 bytes), but cannot authenticate/decrypt it.
The browser rejects unsupported formats, malformed encoding, authentication
failure, invalid UTF-8 and oversized messages without any plaintext fallback.
Whitespace, newlines, Unicode and links are preserved.

The WebSocket inbound message limit is 96 KiB, including JSON. Quota is charged
for the actual envelope length, ignoring client-supplied sizes, under the same
lock as file reservations. Redis persists the envelope unchanged; no server
chat cipher, derived chat key or server-side encryption layer remains.

History responses contain at most `config.HISTORY_PAGE_SIZE` messages (64 by
default) and include `next_offset`
and `more`. Each message's authoritative zero-based `id` is its Redis list
position; live broadcasts use the position returned by RPUSH. The browser
serializes decryption, displays contiguous positions, and deduplicates overlap
between live delivery, replay and reconnect. At most 256 out-of-order messages
are buffered before reporting an error and reconnecting to replay. Displayed
chat history still grows with the folder's messages; bounded file-transfer
memory does not imply a constant-memory conversation UI.

A message with a bad envelope produces a visible error row at its own position
and does not stop subsequent messages. Earlier server-encrypted chat is not
decrypted or migrated. Plaintext clients receive an explicit error and no quota
charge. Local encryption/size/connection failures keep the draft; a server quota
rejection is reported visibly after send.

Sequence, sender, date and size are server metadata, not authenticated AEAD
fields. These IDs suppress reconnect duplicates, not malicious-server replay
under a new ID. A shared folder key authenticates contents, not an individual
sender; all code holders can author messages.

## Metadata and record layout

`libsodium-wrappers` is pinned to 0.8.4. Its secretstream implementation is
XChaCha20-Poly1305 with automatic nonce management and rekeying, not reused-IV
chunked GCM.

Each file has a fresh random 32-byte secretstream key and a fresh 24-byte
secretstream header. Metadata JSON contains `v: 2`, `name`, original `size`,
and base64url `key` and `header` fields. It is encrypted using
XChaCha20-Poly1305 AEAD under the derived metadata key with a random 24-byte
nonce and associated data `snapfile:file-metadata:v2`. The wire metadata string
is base64url without padding of nonce followed by ciphertext/tag. Filenames
are never used in file-request URLs or plaintext server file messages.

The binary file consists of:

| Field | Encoding |
| --- | --- |
| Magic/version | Eight ASCII bytes `SNAPFE02` |
| Secretstream header | 24 bytes, also authenticated inside metadata |
| Data records | Four-byte big-endian ciphertext length followed by a secretstream record |
| Final record | Length 17, authenticated empty plaintext with secretstream `TAG_FINAL` |

Plaintext data records are exactly 1 MiB except for the last nonempty data
record. Every data record uses `TAG_MESSAGE`. Associated data for every record
is the 32-byte envelope header followed by the 32-byte unkeyed BLAKE2b hash of
the encrypted metadata string. This binds file contents, format and metadata.

Ciphertext size is computed in advance as 32 header bytes, the original byte
count, and 21 bytes per data record plus one mandatory final record.
An empty file still has a 53-byte authenticated envelope.

The parser handles arbitrary network boundaries, never interprets them as
record boundaries, rejects record lengths outside 17 through 1 MiB + 17 before
allocation, and enforces the metadata plaintext length. Incorrect headers,
alteration, reordering, duplication, truncation, missing FINAL, unsupported tags
and any trailing bytes fail authentication/format validation. A file is not
committed to its destination until FINAL and EOF are both verified.

The pinned JS wrapper returns a WASM state pointer and does not expose the
`free()` helper shown in newer upstream documentation. The local cleanup helper
uses the verified 0.8.4 core state-size, heap and `_free` exports to wipe and free
that pointer exactly once on success, failure or cancellation. Upgrading sodium
requires checking this contract and running the crypto tests.

## Streaming and failure handling

Encryption is a zero-prefetch pull-driven ReadableStream. A file slice of at
most 1 MiB is read only when fetch requests the next record. Ciphertext records
are sent directly through same-origin fetch with `duplex: 'half'`. Sequential
multifile upload bounds the number of active crypto streams. The UI's encryption
percentage is not a claim about server-received bytes.

Upload errors are shown in red with their stage (browser support, preparation,
quota admission or streaming). Server rejections retain their specific message;
a quota or disk error does not imply a transport problem. Browser guidance is
shown only when streaming APIs are missing or a secure context is unavailable,
and HTTP2/HTTP3 guidance only when HTTP1 is observed. Generic fetch failures do
not identify an HTTP version. Failed cleanup is reported separately without
replacing the original upload error. Retrying clears the error state, and normal
progress, success and cancellation are not styled as errors.

Download calls `showSaveFilePicker` directly in the click handler, before a
network await, then writes authenticated records to `createWritable()`. Each
write is awaited before reading another record. A BYOB network reader limits each
read buffer to 64 KiB. Authentication errors and user
cancellation abort the writable, preserving an existing destination file rather
than committing partial plaintext. There is no fallback that accumulates a Blob.

Pipeline buffering is independent of total file length: a fixed-size plaintext
slice, framed ciphertext record, bounded parser record, and browser/network
buffers. The tests instrument record sizes, read-ahead and stalled-destination
behavior; they do not assert a bound on whole-browser RSS.

## Server storage and quota

`POST /files` admits `{size, metadata}` for an authenticated folder, reserving exact
ciphertext bytes plus the encrypted metadata string length. It returns an
unpredictable token. `PUT /files/<token>` consumes that admission once and
streams `application/octet-stream` into a numbered `.part` file with 64 KiB
reads. Requests do not need Content-Length. Actual received bytes must equal
the admitted count; both overflow and short bodies fail.

A successful upload renames the file and persists its opaque metadata message
before broadcasting it. `GET /files?id=<number>` returns the stored ciphertext
unchanged, without needing a filename query. An extra `name` query is ignored,
never used for paths or response headers; the browser never sends filenames.
The common `/files` namespace handles downloads, JSON admission, streaming PUT
and cancellation. Old multipart payloads and server-side file decryption are
not supported. The server cannot authenticate ciphertext; the receiving browser
does that.

An in-process per-folder lock covers quota reservations, chat charges and file
commits. Concurrent admissions cannot spend the same space. At most eight
admissions per folder may be pending/active; unused admissions expire after
60 seconds and are reclaimed on subsequent admission. Active reads time out
after 30 seconds without input. Cancellation, bad sizes and failed requests
delete partial files and release reservations. `DELETE /files/<token>` cancels
an active upload or releases its unused admission; final commit is not interrupted
once begun. A disconnected client that never received its admission token can
leave its reservation until the admission expires.
These limits live in `config.py`: `MAX_PENDING_UPLOADS`,
`UPLOAD_ADMISSION_TIMEOUT`, `UPLOAD_READ_TIMEOUT` and `MAX_FILE_METADATA`
(24,000 bytes). A folder already over quota can still be opened and downloaded;
new chat messages and file admissions remain blocked until there is space.

The existing deployment model is one backend process with one folder/websocket
cache. Multiple independent workers are not supported by this accounting model.

## Optional NGINX download offload

`USE_X_ACCEL_REDIRECT = False` is the default in `server/snapfile/config.py`;
the PROD section overrides it with `True`. Change that section to `False` when
running production without NGINX. There is no environment-variable flag parser;
only `ENV` selects a config section.

Both modes authorize the folder, validate the numeric file ID and check the
file exists before responding. Enabled mode returns `X-Accel-Redirect` with
`/download/<shard>/<folder-hash>/<file-id>`; disabled mode streams the same
ciphertext with aiohttp `FileResponse`. Neither path sends a plaintext filename,
passcode or encryption key in a URL or header. Responses remain
`application/octet-stream`, `Cache-Control: no-store`, `Content-Disposition: attachment`;
the browser decrypts the filename metadata and contents locally.

NGINX must use the checked-in `internal` `/download/` location in
`deploy/snapfile.conf`. Its alias `/var/www/snapfile/files/` must match the
backend's upload root and be readable by NGINX. Both prefix and alias keep their
trailing slash; `^~` prevents other regex locations from overriding the internal
guard. Only numeric committed filenames under validated shard/folder paths are
accepted, not `.part` uploads. Direct requests to this location are denied even
with a session cookie. Install this location before enabling the flag; Node/Vite
test proxies do not implement X-Accel-Redirect and must leave it disabled.

## Transport and trust limits

Current desktop Chromium/Edge, a secure context, browser-facing HTTP/2 or HTTP/3,
and File System Access support are required. aiohttp remains HTTP/1 behind the
TLS/H2 proxy. nginx must disable request buffering for the streaming upload
routes. Self-signed certificate acceptance in the isolated test context does not
change the negotiated HTTP version or bypass Chromium's upload-stream restriction.

File/message lengths, timing, order and sender information remain visible. The
server receives only ciphertext and an authentication token, both of which
permit offline passcode guessing.
Malicious application JavaScript, compromised browser storage and authorized
recipients are outside this encryption guarantee. A high-entropy sharing
and recovery design is deliberately deferred in the README TODO.
