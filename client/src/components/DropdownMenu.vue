<template>
  <div id="dropdown">
    <div id="toggle" :class="{ on: open }" @click="toggle">
      <div class="one"></div>
      <div class="two"></div>
      <div class="three"></div>
    </div>
    <div id="menu" :class="{ open }">
      <ul>
        <li><a href="#" @click.prevent="share">Share</a></li>
        <li><a href="#" id="logout" @click.prevent="logout">Logout</a></li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  }
});
const emit = defineEmits(['update:open', 'share', 'logout']);

const open = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
});

function toggle() {
  open.value = !open.value;
}

function share() {
  emit('share');
  open.value = false;
}

function logout() {
  emit('logout');
  open.value = false;
}
</script>
