<template>
  <table>
    <tbody>
      <tr v-for="message in messages" :key="message.date + message.data">
        <td :colspan="message.type === 0 ? 2 : 1">
          <template v-if="message.type === 0">
            <a v-if="isUrl(message.data)" :href="message.data" target="_blank" rel="noreferrer">
              {{ message.data }}
            </a>
            <span v-else>{{ message.data }}</span>
          </template>
          <template v-else>
            <a :href="buildFileUrl(message)" target="_blank" rel="noreferrer">
              {{ message.data }}
            </a>
          </template>
        </td>
        <td v-if="message.type === 1" class="right">{{ message.size }}</td>
        <td>{{ formatDate(message.date) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>

const props = defineProps({
  messages: {
    type: Array,
    default: () => []
  }
});

const urlRegex = /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)$/i;

function formatDate(value) {
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

function isUrl(value) {
  return urlRegex.test(value);
}

function buildFileUrl(message) {
  if (!message.file_id) {
    return '#';
  }
  const params = new URLSearchParams({
    id: message.file_id,
    name: message.data
  });
  return `/files?${params.toString()}`;
}
</script>
