<template>
  <div v-if="open" class="qr-overlay" @click.self="emit('close')">
    <img v-if="image" :src="image" alt="Share QR code" class="qr-image" />
    <p v-else class="qr-loading">Generating QR code…</p>
  </div>
</template>

<script setup>
defineProps({
  open: {
    type: Boolean,
    default: false
  },
  image: {
    type: String,
    default: null
  }
});
const emit = defineEmits(['close']);
</script>

<style scoped>
.qr-overlay {
  display: flex;
  justify-content: center; /* align horizontal */
  align-items: center; /* align vertical */
  position: fixed; /* Stay in place */
  z-index: 1; /* Sit on top */
  left: 0;
  top: 0;
  width: 100%; /* Full width */
  height: 100%; /* Full height */
  overflow: auto; /* Enable scroll if needed */
  background-color: rgba(0,0,0,0.4); /* Black w/ opacity */
}

.qr-image {
  /* QR code image styling to match original size */
  width: 256px;
  height: 256px;
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
}

.qr-loading {
  color: white;
  font-size: 18px;
  text-align: center;
}
</style>
