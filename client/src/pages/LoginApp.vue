<template>
  <div class="login-page">
    <div class="login-card">
      <h1>Snapfile</h1>
      <h2>A secure chat and file sharing application that enables access from any device</h2>

      <form @submit.prevent="handleLogin">
        <input
          type="password"
          name="identity"
          placeholder="Please input your passcode"
          autocomplete="current-password"
          v-model="passcode"
          required
        />
        <button type="submit" class="primary" :disabled="submitting">
          {{ submitting ? 'Opening…' : 'Open Your Folder' }}
        </button>
      </form>

      <p class="divider">Or</p>

      <div class="actions">
        <button type="button" @click="createFolder" :disabled="creating">
          {{ creating ? 'Creating…' : 'Create A New Folder' }}
        </button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';

const formHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
};

function sha256(input) {
  // Placeholder for real hash if needed
  return input;
}

async function login(identity) {
  const response = await fetch('/login', {
    method: 'POST',
    headers: formHeaders,
    body: new URLSearchParams({ identity })
  });
  if (!response.ok) {
    throw new Error('Login failed');
  }
}

async function signup(identity) {
  const response = await fetch('/signup', {
    method: 'POST',
    headers: formHeaders,
    body: new URLSearchParams({ identity })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Signup failed');
  }
}

const passcode = ref('');
const submitting = ref(false);
const creating = ref(false);
const error = ref('');

async function handleLoginWithPasscode(raw) {
  submitting.value = true;
  error.value = '';
  try {
    const normalized = raw.trim();
    await login(sha256(normalized.toLowerCase()));
    localStorage.setItem('identity', normalized);
    window.location.href = '/';
  } catch (err) {
    console.error(err);
    error.value = 'Wrong passcode or expired!';
  } finally {
    submitting.value = false;
  }
}

async function handleLogin() {
  if (!passcode.value) {
    return;
  }
  await handleLoginWithPasscode(passcode.value);
}

function genRandomCode() {
  return Math.random().toString(36).substring(2, 8);
}

async function createFolder() {
  creating.value = true;
  error.value = '';
  let attempts = 5;
  while (attempts > 0) {
    const candidate = genRandomCode();
    try {
      await signup(sha256(candidate.toLowerCase()));
      localStorage.setItem('identity', candidate);
      window.location.href = '/';
      return;
    } catch (err) {
      console.warn('Signup failed', err);
      attempts -= 1;
      if (attempts === 0) {
        error.value = err?.message || 'Failed to create folder';
      }
    }
  }
  creating.value = false;
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  const sharedIdentity = params.get('identity');
  if (sharedIdentity) {
    handleLoginWithPasscode(sharedIdentity);
  }
});
</script>

<style scoped>
.error {
  color: #f5222d;
  margin-top: 12px;
}
</style>
