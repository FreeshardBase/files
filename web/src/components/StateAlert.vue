<script setup lang="ts">
// The guide's alert banner (PDF p.17, #240): a danger hairline on a 7 % danger tint, a bold title, one sentence and
// the one way on (the slot: "Try again" or a link back). It stands in for a view's content when that content cannot be
// shown, so its title is the page's heading.
defineProps<{ title: string; text: string }>();
</script>

<template>
  <div
    class="alert-banner"
    role="alert"
  >
    <h1 class="alert-title">
      {{ title }}
    </h1>
    <p class="alert-text">
      {{ text }}
    </p>
    <div
      v-if="$slots.default"
      class="alert-actions"
    >
      <slot />
    </div>
  </div>
</template>
