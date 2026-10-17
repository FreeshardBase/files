<script setup lang="ts">
// The chip editor of one item in the details drawer (#212): its tags as chips (each a link to the tag view) with a
// remove button, and with `editable` a field that adds a tag (Enter or "Add"), suggesting the member's other tags. A
// refusal (too long, the 21st tag) stays in the editor with the typed name.
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { foldTag, MAX_TAG_LENGTH, MAX_TAGS_PER_ITEM, normalizeTagName, tagColor } from '@files/shared';
import { ApiFailure } from '../api/client.ts';
import { tagRoute } from '../api/paths.ts';
import { useTagsStore } from '../stores/tags.ts';

const props = defineProps<{ source: string; path: string; name: string; editable: boolean }>();
const { t } = useI18n();
const store = useTagsStore();
const tags = ref<string[] | null>(null);
const value = ref('');
const error = ref('');
const busy = ref(false);
const headingId = useId();
const listId = useId();
const errorId = useId();
const suggestions = computed(() => {
  const have = new Set((tags.value ?? []).map(foldTag));
  return store.all.map((x) => x.name).filter((n) => !have.has(foldTag(n)));
});
const fail = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  error.value = t(`errors.${e.code}`, e.params ?? {});
};

onMounted(async () => {
  void store.loadAll();
  try { tags.value = await store.ofItem(props.source, props.path); }
  catch (e) { fail(e); tags.value = []; }
});

async function add() {
  if (busy.value) return;
  error.value = '';
  const name = normalizeTagName(value.value);
  if (name === null) { error.value = t('errors.TAG_INVALID', { max: MAX_TAG_LENGTH }); return; }
  busy.value = true;
  try {
    const [item] = await store.add(props.source, [props.path], name);
    tags.value = item?.tags ?? tags.value;
    value.value = '';
  } catch (e) { fail(e); }
  finally { busy.value = false; }
}
async function remove(tag: string) {
  error.value = '';
  try {
    await store.remove(props.source, props.path, tag);
    tags.value = (tags.value ?? []).filter((x) => x !== tag);
  } catch (e) { fail(e); }
}
</script>

<template>
  <section
    class="tag-editor"
    :aria-labelledby="headingId"
  >
    <h3
      :id="headingId"
      class="fs-section-heading"
    >
      {{ t('tags.heading') }}
    </h3>
    <ul
      v-if="tags && tags.length"
      class="tag-chips tag-chips-edit"
      :aria-label="t('tags.ofItem', { name })"
    >
      <li
        v-for="tag in tags"
        :key="tag"
        class="tag-chip"
        :data-color="tagColor(tag)"
      >
        <span
          class="tag-dot"
          aria-hidden="true"
        />
        <RouterLink
          class="tag-chip-text"
          :to="tagRoute(tag)"
        >
          {{ tag }}
        </RouterLink>
        <button
          type="button"
          class="tag-remove"
          :aria-label="t('tags.remove', { tag })"
          :title="t('tags.remove', { tag })"
          @click="remove(tag)"
        >
          <span
            class="icon icon-close"
            aria-hidden="true"
          />
        </button>
      </li>
    </ul>
    <p
      v-else-if="tags && !editable"
      class="share-note"
    >
      {{ t('tags.none') }}
    </p>
    <form
      v-if="editable && tags && tags.length < MAX_TAGS_PER_ITEM"
      class="tag-add"
      @submit.prevent="add"
    >
      <label
        class="visually-hidden"
        :for="`${listId}-input`"
      >{{ t('tags.addLabel') }}</label>
      <input
        :id="`${listId}-input`"
        v-model="value"
        class="fs-input"
        type="text"
        :list="listId"
        :maxlength="MAX_TAG_LENGTH * 2"
        :placeholder="t('tags.addPlaceholder')"
        autocomplete="off"
        spellcheck="false"
        enterkeyhint="done"
        :aria-invalid="error !== ''"
        :aria-describedby="error ? errorId : undefined"
        @input="error = ''"
      >
      <datalist :id="listId">
        <option
          v-for="s in suggestions"
          :key="s"
          :value="s"
        />
      </datalist>
      <button
        type="submit"
        class="button"
        :disabled="busy || value.trim() === ''"
      >
        {{ t('tags.add') }}
      </button>
    </form>
    <p
      v-if="error"
      :id="errorId"
      class="fs-field__error"
      role="alert"
    >
      {{ error }}
    </p>
  </section>
</template>
