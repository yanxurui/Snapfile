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
      <MessageTable :messages="messages" />
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
        <span class="percent">{{ percentText }}</span>
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

  socket.addEventListener('open', () => {
    console.log('WebSocket connected');
  });

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.action === 'connect') {
      const info = payload.info ?? {};
      info.identity = (localStorage.getItem('identity') || '').toUpperCase();
      handlers.onConnect(info);
      const offset = handlers.getOffset?.() ?? 0;
      socket.send(
        JSON.stringify({
          action: 'pull',
          offset
        })
      );
    } else if (payload.action === 'send' && Array.isArray(payload.msgs)) {
      handlers.onMessages(payload.msgs);
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

function sendMessage(socket, text) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: 'send', data: text }));
  }
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
const currentXhr = ref(null);
const uploadMetrics = reactive({ lastTime: 0, lastLoaded: 0 });

const toast = reactive({ visible: false, message: '' });
const toastTimer = ref(null);
const qr = reactive({ open: false, image: null });

// ---------------------------------------------------------------------------
// Derived state and watchers
// ---------------------------------------------------------------------------
const canSend = computed(() => messageText.value.trim().length > 0 && socket.value?.readyState === WebSocket.OPEN);

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
onMounted(() => {
  initSocket();
});

onBeforeUnmount(() => {
  manualClose.value = true;
  clearReconnectTimer();
  socket.value?.close();
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
    onConnect: (info) => {
      statusInfo.value = info;
      reconnectAttempts.value = 0;
    },
    onMessages: (msgs) => {
      appendMessages(msgs);
    },
    getOffset: () => messages.value.length,
    onClose: () => {
      menuOpen.value = false;
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

function appendMessages(newMessages) {
  messages.value = [...messages.value, ...newMessages];
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
function sendCurrentMessage() {
  if (!canSend.value || !socket.value) return;
  sendMessage(socket.value, messageText.value.trim());
  messageText.value = '';
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

function uploadFiles(files) {
  if (uploading.value) {
    return;
  }
  const list = Array.from(files);
  if (list.length === 0) {
    return;
  }
  uploading.value = true;
  percentText.value = '0%';
  uploadMetrics.lastTime = performance.now();
  uploadMetrics.lastLoaded = 0;

  const formData = new FormData();
  list.forEach((file) => formData.append('myfile[]', file, file.name));

  const xhr = new XMLHttpRequest();
  currentXhr.value = xhr;

  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      const percent = Math.round((event.loaded / event.total) * 100);
      const now = performance.now();
      const deltaTime = now - uploadMetrics.lastTime;
      if (deltaTime > 400) {
        const deltaBytes = event.loaded - uploadMetrics.lastLoaded;
        const speed = formatSize((deltaBytes / deltaTime) * 1000);
        percentText.value = `${percent}% ${speed}/s`;
        uploadMetrics.lastTime = now;
        uploadMetrics.lastLoaded = event.loaded;
      }
    }
  };

  xhr.onload = () => {
    uploading.value = false;
    if (xhr.status === 200) {
      percentText.value = `Success: ${xhr.responseText}`;
      showToast('Upload complete');
    } else if (xhr.status === 431) {
      percentText.value = 'Error: Storage space not enough';
      showToast('Storage space not enough');
    } else if (xhr.status === 413) {
      percentText.value = 'Error: File too large';
      showToast('File too large');
    } else {
      percentText.value = `Error: ${xhr.responseText || xhr.statusText}`;
      showToast('Upload failed');
    }
    currentXhr.value = null;
  };

  xhr.onerror = () => {
    uploading.value = false;
    percentText.value = 'Error: Upload failed';
    currentXhr.value = null;
    showToast('Upload failed');
  };

  xhr.open('POST', '/files');
  xhr.send(formData);
}

function cancelUpload() {
  currentXhr.value?.abort();
  uploading.value = false;
  percentText.value = 'Canceled';
  currentXhr.value = null;
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
  const url = `${window.location.origin}/login.html?identity=${currentIdentity}`;
  try {
    await copyToClipboard(url);
    showToast('Link copied!');
  } catch (err) {
    console.error(err);
    showToast('Failed to copy link');
  }
  try {
    if (!qr.image) {
      qr.image = await QRCode.toDataURL(url);
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
