<template>
  <transition name="fade">
    <div v-if="visible" class="popup">{{ message }}</div>
  </transition>
</template>

<script setup>
defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  message: {
    type: String,
    default: ''
  }
});
</script>

<style scoped>
.popup {
  display: block;
  color: #fff;
  background-color: #555;
  text-align: center;
  border-radius: 4px;
  padding: 5px 10px;
  position: fixed;
  z-index: 1000;
  top: 20%;
  left: 50%;
  transform: translateX(-50%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
