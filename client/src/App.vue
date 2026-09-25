<template>
  <div
    id="container"
    :class="{ dragging: dragActive }"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div id="top">
      <StatusBar v-if="statusInfo" :info="statusInfo" :visible="!!statusInfo" />
      <DropdownMenu v-model:open="menuOpen" @share="handleShare" @logout="handleLogout" />
    </div>

    <div id="middle" ref="messageContainer">
      <MessageTable :messages="messages" @download="downloadEncryptedFile" />
    </div>

    <div id="bottom">
      <textarea
        id="text"
        rows="3"
        v-model="messageText"
        placeholder="type here to send a message or drag&drop to upload files"
        @keydown.enter.exact.prevent="sendCurrentMessage"
      ></textarea>
      <div class="inputAddon">
        <button class="left" id="upload_files" type="button" :disabled="uploading" @click="triggerFileInput">
          Upload files
        </button>
        <button class="left" id="cancel" type="button" v-if="uploading" @click="cancelUpload">
          Cancel
        </button>
        <span
          class="percent"
          :class="{ 'upload-error': uploadError }"
          :role="uploadError ? 'alert' : undefined"
          aria-live="polite"
          aria-atomic="true"
        >{{ percentText }}</span>
        <button
          class="right"
          id="send_message"
          type="button"
          :disabled="!canSend"
          @click="sendCurrentMessage"
        >
          Send message
        </button>
      </div>
      <p v-if="messageError" class="message-error" role="alert">{{ messageError }}</p>
      <div v-if="downloading" role="status">
        {{ downloadStatus }}
        <button type="button" @click="downloadController?.abort()">Cancel download</button>
      </div>
      <p v-else-if="downloadStatus" role="status">{{ downloadStatus }}</p>
      <input ref="fileInput" type="file" multiple hidden @change="onFilesSelected" />
    </div>

    <PopupToast :visible="toast.visible" :message="toast.message" />
    <QrModal :open="qr.open" :image="qr.image" @close="qr.open = false" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import StatusBar from '@/components/StatusBar.vue';
import DropdownMenu from '@/components/DropdownMenu.vue';
import MessageTable from '@/components/MessageTable.vue';
import PopupToast from '@/components/PopupToast.vue';
import QrModal from '@/components/QrModal.vue';
import QRCode from 'qrcode';
import { credentials, encryptFile, decryptFile, decryptMetadata, encryptChat, decryptChat } from '@/crypto.js';

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
const RECONNECT_BASE_DELAY = 500;
const RECONNECT_MAX_DELAY = 60000;
const TOAST_DURATION = 2000;

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0B';
  }
  const units = ['B', 'K', 'M', 'G'];
  let size = bytes;
  let unit = units.shift();
  for (const nextUnit of units) {
    if (size < 1000) {
      break;
    }
    size /= 1000;
    unit = nextUnit;
  }
  return `${size.toFixed(1)}${unit}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text', err);
    throw err;
  }
}

function createSocket(handlers) {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const socket = new WebSocket(wsUrl);
  let historyInFlight = false;
  function pullHistory(offset) {
    if (socket.readyState !== WebSocket.OPEN) return;
    historyInFlight = true;
    socket.send(JSON.stringify({ action: 'pull', offset }));
  }

  socket.addEventListener('open', () => {
    console.log('WebSocket connected');
  });

  socket.addEventListener('message', async (event) => {
    if (!handlers.isCurrent(socket) || socket.readyState !== WebSocket.OPEN) return;
    try {
      const payload = JSON.parse(event.data);
      if (payload.action === 'connect') {
        const info = payload.info ?? {};
        info.identity = (localStorage.getItem('identity') || '').toUpperCase();
        handlers.onConnect(info);
        pullHistory(handlers.getOffset());
      } else if (payload.action === 'send' && Array.isArray(payload.msgs)) {
        await handlers.onMessages(payload.msgs);
        if (!handlers.isCurrent(socket)) return;
        if (Number.isSafeInteger(payload.next_offset)) {
          if (payload.more) {
            pullHistory(payload.next_offset);
            return;
          }
          historyInFlight = false;
          if (!payload.msgs.length && handlers.hasGap()) {
            throw new Error('Incomplete message history; reload to retry');
          }
        }
        if (!historyInFlight && handlers.hasGap()) pullHistory(handlers.getOffset());
      } else if (payload.action === 'error') {
        handlers.onServerError(payload.message);
      } else {
        throw new Error('Invalid server message');
      }
    } catch (error) {
      console.error(error);
      handlers.onServerError(`Unable to read messages: ${error.message}`);
    }
  });

  if (handlers.onClose) {
    socket.addEventListener('close', handlers.onClose);
  }
  if (handlers.onError) {
    socket.addEventListener('error', handlers.onError);
  }

  return socket;
}

async function logout() {
  await fetch('/logout', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
if (!localStorage.getItem('identity')) {
  window.location.href = '/login.html';
}

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------
const messages = ref([]);
const statusInfo = ref(null);

const socket = ref(null);
const manualClose = ref(false);
const reconnectTimer = ref(null);
const reconnectAttempts = ref(0);

const menuOpen = ref(false);
const messageText = ref('');
const messageContainer = ref(null);
const dragActive = ref(false);
const fileInput = ref(null);

const uploading = ref(false);
const percentText = ref('');
const uploadError = ref(false);
let fileKey;
let chatKey;
let messageQueue = Promise.resolve();
const pendingMessages = new Map();
const sendingMessage = ref(false);
const messageError = ref('');
let uploadController;
let downloadController;
const downloading = ref(false);
const downloadStatus = ref('');

const toast = reactive({ visible: false, message: '' });
const toastTimer = ref(null);
const qr = reactive({ open: false, image: null });

// ---------------------------------------------------------------------------
// Derived state and watchers
// ---------------------------------------------------------------------------
const canSend = computed(() => !sendingMessage.value && messageText.value.trim().length > 0 &&
  !!chatKey && socket.value?.readyState === WebSocket.OPEN);

watch(
  () => messages.value.length,
  () => {
    requestAnimationFrame(() => {
      const container = messageContainer.value;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------
onMounted(async () => {
  try {
    const keys = await credentials(localStorage.getItem('identity'));
    fileKey = keys.key;
    chatKey = keys.chatKey;
    initSocket();
  } catch (error) {
    showToast(error.message);
  }
});

onBeforeUnmount(() => {
  manualClose.value = true;
  clearReconnectTimer();
  socket.value?.close();
  uploadController?.abort();
  downloadController?.abort();
  if (toastTimer.value) {
    clearTimeout(toastTimer.value);
  }
});

// ---------------------------------------------------------------------------
// Socket management
// ---------------------------------------------------------------------------
function initSocket() {
  clearReconnectTimer();
  if (socket.value) {
    manualClose.value = true;
    socket.value.close();
    manualClose.value = false;
  }
  manualClose.value = false;
  socket.value = createSocket({
    isCurrent: (connection) => connection === socket.value,
    onConnect: (info) => {
      statusInfo.value = info;
      reconnectAttempts.value = 0;
    },
    onMessages: (msgs) => {
      messageQueue = messageQueue.then(() => appendMessages(msgs)).catch((error) => {
        console.error(error);
        pendingMessages.clear();
        messageError.value = `Unable to read messages: ${error.message}`;
        socket.value?.close();
      });
      return messageQueue;
    },
    getOffset: () => messages.value.length,
    hasGap: () => pendingMessages.size > 0,
    onServerError: (error) => {
      messageError.value = error;
      showToast(error);
    },
    onClose: async (event) => {
      if (event.target !== socket.value) return;
      menuOpen.value = false;
      if (event.code === 4000 && !manualClose.value) {
        try {
          const { auth } = await credentials(localStorage.getItem('identity'));
          const response = await fetch('/login', { method: 'POST',
            body: new URLSearchParams({ identity: auth }) });
          if (response.ok) { scheduleReconnect(); return; }
        } catch (error) { console.error(error); }
        window.location.href = '/login.html';
        return;
      }
      scheduleReconnect();
    }
  });
}

function clearReconnectTimer() {
  if (reconnectTimer.value !== null) {
    clearTimeout(reconnectTimer.value);
    reconnectTimer.value = null;
  }
}

function scheduleReconnect() {
  if (manualClose.value) {
    return;
  }
  const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts.value));
  reconnectAttempts.value += 1;
  showToast('Connection lost. Reconnecting…');
  reconnectTimer.value = window.setTimeout(() => {
    initSocket();
  }, delay);
}

async function appendMessages(newMessages) {
  for (const message of newMessages) {
    if (!Number.isSafeInteger(message.id) || message.id < 0) throw new Error('Invalid message history index');
    if (message.id < messages.value.length || pendingMessages.has(message.id)) continue;
    if (pendingMessages.size >= 256) throw new Error('Message history synchronization buffer exceeded');
    pendingMessages.set(message.id, message);
  }
  while (pendingMessages.has(messages.value.length)) {
    const message = pendingMessages.get(messages.value.length);
    let decoded;
    if (message.type === 1) {
      try {
        const meta = await decryptMetadata(message.data, fileKey);
        decoded = { ...message, metadata: message.data, data: meta.name, size: formatSize(meta.size) };
      } catch (error) {
        console.error('File metadata authentication failed', error);
        decoded = { ...message, data: 'File cannot be decrypted: invalid key or metadata', decryptError: true };
      }
    } else {
      try {
        if (message.type !== 0) throw new Error('Unsupported message type');
        decoded = { ...message, data: await decryptChat(message.data, chatKey) };
      } catch (error) {
        console.error('Chat authentication failed', error);
        decoded = { ...message, type: 0, data: 'Message cannot be decrypted: invalid key or encrypted data',
          decryptError: true };
      }
    }
    pendingMessages.delete(message.id);
    messages.value.push(decoded);
  }
}

// ---------------------------------------------------------------------------
// Toast helpers
// ---------------------------------------------------------------------------
function showToast(msg) {
  toast.message = msg;
  toast.visible = true;
  if (toastTimer.value) {
    clearTimeout(toastTimer.value);
  }
  toastTimer.value = window.setTimeout(() => {
    toast.visible = false;
    toastTimer.value = null;
  }, TOAST_DURATION);
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
async function sendCurrentMessage() {
  if (!canSend.value || !socket.value) return;
  const text = messageText.value;
  const connection = socket.value;
  sendingMessage.value = true;
  messageError.value = '';
  try {
    const data = await encryptChat(text, chatKey);
    if (connection !== socket.value || connection.readyState !== WebSocket.OPEN) {
      throw new Error('Connection lost before sending. Your message has not been sent.');
    }
    if (connection.bufferedAmount > 96 * 1024) throw new Error('Connection is busy. Please try sending again.');
    connection.send(JSON.stringify({ action: 'send', data }));
    if (messageText.value === text) messageText.value = '';
  } catch (error) {
    console.error(error);
    messageError.value = error.message;
  } finally {
    sendingMessage.value = false;
  }
}

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------
function triggerFileInput() {
  fileInput.value?.click();
}

function onFilesSelected(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  if (target.files && target.files.length > 0) {
    uploadFiles(target.files);
  }
  target.value = '';
}

function cancelUpload() {
  uploadController?.abort();
}

async function checked(response) {
  if (response.ok) return response;
  throw new Error((await response.text()) || `Request failed (${response.status})`);
}

function checkUploadSupport() {
  if (!window.isSecureContext) {
    throw new Error('Encrypted uploads require a secure context. Open Snapfile over HTTPS.');
  }
  const unsupported = 'This browser does not support streaming uploads. Use current desktop Chrome or Edge.';
  if (typeof ReadableStream !== 'function' || typeof Request !== 'function') {
    throw new Error(unsupported);
  }
  // Browsers that stringify stream bodies do not support streaming requests.
  let duplexRead = false;
  let request;
  try {
    request = new Request(location.href, {
      method: 'POST',
      body: new ReadableStream({ start(controller) { controller.close(); } }),
      get duplex() { duplexRead = true; return 'half'; }
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error(unsupported, { cause: error });
  }
  if (!duplexRead || request.headers.has('Content-Type')) throw new Error(unsupported);
}

async function uploadFiles(files) {
  if (uploading.value || !files.length) return;
  uploadError.value = false;
  percentText.value = 'Preparing upload...';
  uploading.value = true;
  uploadController = new AbortController();
  const { signal } = uploadController;
  let count = 0;
  let stage = 'checking browser support';
  let cleanupMessage = '';
  try {
    checkUploadSupport();
    for (const file of Array.from(files)) {
      signal.throwIfAborted();
      let token;
      let encrypted;
      try {
        stage = 'preparing file';
        encrypted = await encryptFile(file, fileKey, {
          onProgress: (produced) => {
            const percentage = file.size ? Math.floor(100 * produced / file.size) : 100;
            percentText.value = `Encrypting ${count + 1}/${files.length}: ${percentage}% (not server-confirmed)`;
          }
        });
        // Finish admission before streaming; the fetch upload response is half-duplex.
        stage = 'reserving space';
        const admission = await checked(await fetch('/files', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ size: encrypted.size, metadata: encrypted.metadata }), signal
        }));
        ({ token } = await admission.json());
        stage = 'sending file';
        const protocol = performance.getEntriesByName(admission.url).at(-1)?.nextHopProtocol ||
          performance.getEntriesByType('navigation')[0]?.nextHopProtocol;
        if (protocol === 'http/1.1' || protocol === 'http/1.0') {
          throw new Error('This connection uses HTTP/1. Streaming uploads require HTTP/2 or HTTP/3 over HTTPS.');
        }
        await checked(await fetch(`/files/${token}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
          body: encrypted.body, duplex: 'half', signal
        }));
        token = null;
        count += 1;
      } finally {
        encrypted?.dispose();
        if (token) {
          try {
            await checked(await fetch(`/files/${token}`, { method: 'DELETE' }));
          } catch (error) {
            console.error('Failed to release upload reservation', error);
            cleanupMessage = ` Could not confirm upload cleanup: ${error.message}.`;
          }
        }
      }
    }
    percentText.value = `Success: ${count} file(s) uploaded (server confirmed)`;
    showToast('Upload complete');
  } catch (error) {
    console.error(error);
    uploadError.value = !signal.aborted || !!cleanupMessage;
    percentText.value = (signal.aborted ? `Canceled (${count} completed)` :
      `Upload failed (${stage}): ${error.message}`) + cleanupMessage;
  } finally {
    uploading.value = false;
    uploadController = null;
  }
}

async function downloadEncryptedFile(message) {
  if (downloading.value) return;
  if (!window.showSaveFilePicker) {
    downloadStatus.value = 'Saving encrypted files requires desktop Chrome or Edge over HTTPS. No in-memory fallback is used.';
    return;
  }
  downloading.value = true;
  downloadController = new AbortController();
  const { signal } = downloadController;
  let writable;
  let handedOff = false;
  try {
    // Keep the picker in the click's user activation, before any async operation.
    const handle = await window.showSaveFilePicker({ suggestedName: message.data });
    signal.throwIfAborted();
    writable = await handle.createWritable();
    downloadStatus.value = 'Downloading and authenticating...';
    const response = await checked(await fetch(`/files?id=${encodeURIComponent(message.file_id)}`, { signal }));
    handedOff = true;
    await decryptFile(response.body, message.metadata, fileKey, writable, { signal });
    downloadStatus.value = 'Saved: authenticated download complete';
  } catch (error) {
    if (writable && !handedOff) await writable.abort();
    console.error(error);
    downloadStatus.value = signal.aborted || error.name === 'AbortError' ? 'Download canceled' :
      `Download failed: ${error.message}. No unauthenticated file was committed.`;
  } finally {
    downloading.value = false;
    downloadController = null;
  }
}

// ---------------------------------------------------------------------------
// Drag & drop handlers
// ---------------------------------------------------------------------------
function onDragOver() {
  dragActive.value = true;
}

function onDragLeave(event) {
  const currentTarget = event.currentTarget;
  if (!(currentTarget instanceof HTMLElement)) return;
  const related = event.relatedTarget;
  if (!related || !currentTarget.contains(related)) {
    dragActive.value = false;
  }
}

function onDrop(event) {
  dragActive.value = false;
  if (event.dataTransfer?.files?.length) {
    uploadFiles(event.dataTransfer.files);
  }
}

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------
async function handleShare() {
  const currentIdentity = localStorage.getItem('identity');
  if (!currentIdentity) {
    showToast('Please login again.');
    return;
  }
  const url = `${window.location.origin}/login.html#identity=${encodeURIComponent(currentIdentity)}`;
  try {
    await copyToClipboard(url);
    showToast('Link copied!');
  } catch (err) {
    console.error(err);
    showToast('Failed to copy link');
  }
  try {
    if (!qr.image) {
      qr.image = await QRCode.toDataURL(url, {
        width: 512,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
    }
    qr.open = true;
  } catch (err) {
    console.error(err);
    showToast('Failed to build QR');
  }
}

async function handleLogout() {
  manualClose.value = true;
  clearReconnectTimer();
  socket.value?.close();
  await logout();
  localStorage.removeItem('identity');
  window.location.href = '/login.html';
}
</script>

<style scoped>
/* App Layout Styles */
#container {
  max-width: 800px;
  height: 100%;
  margin: 0 auto;
  padding: 10px;
  box-sizing: border-box;
  display: flex;
  flex-flow: column;
}

#container.dragging {
  background-color: antiquewhite;
}

#top {
  flex: 0 1 auto;
  display: flex;
}

#middle {
  flex: 1 1 auto;
  overflow-y: scroll;
  border-top: 2px solid gray;
}

#bottom {
  position: relative;
  flex: 0 1 auto;
}

.inputAddon {
  display: flex;
  align-items: baseline;
  flex-flow: row nowrap;
}

.inputAddon span {
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.inputAddon .upload-error {
  color: #b00020;
  white-space: normal;
  overflow-wrap: anywhere;
}

textarea {
  /*border: none;*/
  /*outline: none;*/
  resize: none;
  width: 100%;
  /*height: 100%;*/
  box-sizing: border-box;
  font-size: 18px;
  background: transparent;
}

/*bootstrap's outline buttons*/
/*default color is green*/
button,
input[type='button'] {
  -webkit-appearance: button;
  appearance: button;
  cursor: pointer;
  color: #28a745;
  background-color: transparent;
  white-space: nowrap;
  border: 1px solid #28a745;
  padding: 0.375rem 0.75rem;
  font-size: 1rem;
}

button:hover:enabled,
input[type='button']:hover:enabled {
  color: white;
  background-color: #28a745;
}

button:disabled,
input[type='button']:disabled {
  opacity: 0.65;
  cursor: default;
}

input.right {
  float: right;
}

input#cancel {
  display: none;
}

/*hide the actual form*/
form#file {
  display: none;
}
</style>
