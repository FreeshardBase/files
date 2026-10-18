<script setup lang="ts">
// The app's brand mark (#244, #314): the line folder glyph (the PWA icon) in front of the name, on every page's header,
// the visitor and signed-out pages included.
</script>

<template>
  <span class="app-title"><span
    class="icon icon-folder app-logo"
    aria-hidden="true"
  />{{ $t('app.name') }}</span>
</template>
