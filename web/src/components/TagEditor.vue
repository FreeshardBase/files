<script setup lang="ts">
// The chip editor of one item in the details drawer (#212): its tags as chips (each a link to the tag view) with a
// remove button, and with `editable` a field that adds a tag (Enter or "Add"), suggesting the member's other tags. A
// refusal (too long, the 21st tag) stays in the editor with the typed name. Adding or removing keeps the focus in the
// drawer (#381): after adding on the field, after removing on the next chip's remove button, else the field.
import { computed, nextTick, onMounted, ref, useId } from 'vue';
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
const root = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
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
// After the next render: the chip's remove button at `index` (or the last one), else the field; without the field (the
// 20th tag) the last remove button.
const focus = async (index?: number) => {
  await nextTick();
  const buttons = root.value?.querySelectorAll<HTMLElement>('.tag-remove') ?? [];
  const chip = index === undefined ? undefined : buttons[Math.min(index, buttons.length - 1)];
  (chip ?? input.value ?? buttons[buttons.length - 1])?.focus();
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
  // "Add tag" is disabled while busy and with an empty field: the field keeps the focus for the next tag.
  void focus();
}
async function remove(tag: string) {
  error.value = '';
  try {
    await store.remove(props.source, props.path, tag);
    const at = (tags.value ?? []).indexOf(tag);
    tags.value = (tags.value ?? []).filter((x) => x !== tag);
    // The chip took its button with it.
    void focus(at);
  } catch (e) { fail(e); }
}
</script>

<template>
  <section
    ref="root"
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
        class="fs-label"
        :for="`${listId}-input`"
      >{{ t('tags.addLabel') }}</label>
      <input
        :id="`${listId}-input`"
        ref="input"
        v-model="value"
        class="fs-input"
        type="text"
        :list="listId"
        :maxlength="MAX_TAG_LENGTH * 2"
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
