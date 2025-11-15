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

<style scoped>
/* Dropdown Menu Styles */
#dropdown {
  position: relative;
}

#toggle {
  display: block;
  width: 28px;
  margin: 10px;
}

#toggle span {
  position: relative;
  display: block;
}

#toggle div {
  width: 100%;
  height: 3px;
  background-color: #444;
  margin: 3px auto;
  transition: all 0.3s;
  backface-visibility: hidden;
}

#toggle.on .one {
  transform: translate(0px, 6px) rotate(45deg);
}

#toggle.on .two {
  opacity: 0;
}

#toggle.on .three {
  transform: translate(0px, -6px) rotate(-45deg);
}

#toggle.on + #menu {
  opacity: 1;
  visibility: visible;
}

/* Menu appearance */
#menu {
  position: absolute;
  right: 0;
  color: #999;
  padding: 10px 0;
  margin: auto;
  font-family: "Segoe UI", Candara, "Bitstream Vera Sans", "DejaVu Sans", "Bitstream Vera Sans", "Trebuchet MS", Verdana, "Verdana Ref", sans-serif;
  text-align: left;
  border-radius: 4px;
  background: #eee;
  box-shadow: 0 1px 8px rgba(0,0,0,0.05);
  display: none;
}

#menu.open {
  display: block;
}

ul,
li,
li a {
  list-style: none;
  display: block;
  margin: 0;
  padding: 0;
}

li a {
  padding: 5px;
  color: #888;
  text-decoration: none;
  transition: all 0.2s;
}

li a#logout {
  color: red;
}

li a:hover,
li a:focus {
  background: #28a745;
  color: #fff;
}
</style>
