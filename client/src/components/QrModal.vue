<template>
  <div v-if="open" class="qr-overlay" @click.self="emit('close')">
    <div class="qr-card">
      <img v-if="image" :src="image" alt="Share QR code" />
      <p v-else>Generating QR code…</p>
    </div>
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
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.qr-card {
  background: white;
  padding: 24px;
  border-radius: 16px;
  box-shadow: 0 20px 45px rgba(15, 23, 42, 0.25);
  text-align: center;
}

.qr-card img {
  width: 240px;
  height: 240px;
}
</style>
