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
/* Login page - Original styling to match the legacy design exactly */
.login-page {
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
  font-family: Arial, Helvetica, sans-serif;
}

.login-card {
  position: relative;
  border-radius: 5px;
  background-color: #f2f2f2;
  padding: 20px 0 30px 0;
  width: min(600px, 100%);
  text-align: center;
}

.login-card h1 {
  margin-top: 0;
  font-size: 2rem;
}

.login-card h2 {
  font-weight: 400;
  color: #555;
}

.login-card form,
.login-card .actions {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.login-card input[type='password'] {
  /*clear ios weird style*/
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  max-width: 600px;
  padding: 16px 8px;
  border: none;
  border-bottom: 2px solid #ddd;
  border-radius: 0;
  margin: 8px 0;
  background: transparent;
  font-size: 18px;
  box-sizing: border-box;
  outline: none;
  transition: border-bottom-color 0.3s ease, color 0.3s ease;
}

.login-card input[type='password']:focus {
  border-bottom-color: #28a745;
}

.login-card input[type='password']:hover {
  border-bottom-color: #999;
}

.login-card input[type='password']::placeholder {
  color: #999;
  transition: color 0.3s ease;
}

.login-card input[type='password']:focus::placeholder {
  color: #666;
}

.login-card button[type='submit'],
.login-card button.primary {
  background-color: green;
  color: white;
  /*clear ios weird style*/
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  max-width: 600px;
  padding: 12px;
  border: none;
  border-radius: 4px;
  margin: 5px 0;
  opacity: 0.85;
  font-size: 20px;
  cursor: pointer;
}

.login-card button[type='submit']:hover,
.login-card button.primary:hover {
  opacity: 1;
}

.login-card button[type='button']:not(.primary) {
  background-color: red;
  color: white;
  /*clear ios weird style*/
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  max-width: 600px;
  padding: 12px;
  border: none;
  border-radius: 4px;
  margin: 5px 0;
  opacity: 0.85;
  font-size: 20px;
  cursor: pointer;
}

.login-card button[type='button']:not(.primary):hover {
  opacity: 1;
}

.login-card .divider {
  margin: 18px 0 4px;
  color: #777;
}

.error {
  color: #f5222d;
  margin-top: 12px;
}
</style>
