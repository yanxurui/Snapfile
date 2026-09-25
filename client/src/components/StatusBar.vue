<template>
  <p id="status_bar" :style="{ opacity: visible ? 1 : 0 }">
    <span>{{ info.identity }}</span>
    <span>expires at {{ formattedExpire }}</span>
    <span>{{ info.usage_percentage }} of {{ info.storage_limit }} used</span>
  </p>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  info: {
    type: Object,
    required: true
  },
  visible: {
    type: Boolean,
    default: false
  }
});

function formatDate(value) {
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

const formattedExpire = computed(() => formatDate(props.info.expire_at));
</script>

<style scoped>
#status_bar {
  margin: 2px;
  padding-right: 8px;
  flex: 1;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  transition: opacity 0.3s ease;
}
</style>
