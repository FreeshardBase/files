<script setup lang="ts">
// An item's comment thread in the details drawer's "Comments" tab (#213): oldest first, each with its author, time and
// "edited", the text as plain text (never markup; links stay text). The composer comes after the thread, so the focus
// order is the comments with their actions, then the field and "Send". In the field Enter sends and Shift+Enter makes a
// new line; the same holds while editing, where Esc cancels without closing the drawer. Delete asks inline, in the row,
// instead of a second dialog over the drawer. The author edits; the author or the item's owner deletes.
import { nextTick, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { MAX_COMMENT_LENGTH, normalizeCommentText, type Comment } from '@files/shared';
import { ApiFailure } from '../api/client.ts';
import { formatDate, intlLocale } from '../format.ts';
import { memberName } from '../memberName.ts';
import { useCommentsStore } from '../stores/comments.ts';

const props = defineProps<{ source: string; path: string; name: string; comments: Comment[] }>();
const emit = defineEmits<{ 'update:comments': [Comment[]] }>();
const { t, locale } = useI18n();
const store = useCommentsStore();
const root = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const text = ref('');
const draft = ref('');
const editing = ref<number | null>(null);
const confirming = ref<number | null>(null);
const busy = ref(false);
const error = ref('');
const message = ref('');
const inputId = useId();
const hintId = useId();
const errorId = useId();
const when = (iso: string) => formatDate(iso, intlLocale(locale.value));
const author = (c: Comment) => (c.mine ? t('comments.you') : memberName(c.author));

function fail(e: unknown) {
  if (!(e instanceof ApiFailure)) throw e;
  error.value = t(`errors.${e.code}`, e.params ?? {});
}
function checked(raw: string): string | null {
  const value = normalizeCommentText(raw);
  if (value === null) error.value = t('errors.COMMENT_INVALID', { max: MAX_COMMENT_LENGTH });
  return value;
}
const update = (list: Comment[]) => {
  emit('update:comments', list);
  store.counted(props.source, props.path, list.length);
};
// The element of `selector` in the thread, else the composer's field.
const focus = async (selector?: string) => {
  await nextTick();
  ((selector ? root.value?.querySelector<HTMLElement>(selector) : null) ?? input.value)?.focus();
};
// Enter sends, Shift+Enter is a new line; an IME composition keeps its Enter.
const sends = (e: KeyboardEvent) => e.key === 'Enter' && !e.shiftKey && !e.isComposing;

async function send() {
  if (busy.value) return;
  error.value = ''; message.value = '';
  const value = checked(text.value);
  if (value === null) return;
  busy.value = true;
  try {
    const c = await store.post(props.source, props.path, value);
    update([...props.comments, c]);
    text.value = '';
    message.value = t('comments.sent');
  } catch (e) { fail(e); }
  finally { busy.value = false; }
}
function onKey(e: KeyboardEvent) {
  if (sends(e)) { e.preventDefault(); void send(); }
}

function startEdit(c: Comment) {
  error.value = ''; message.value = '';
  confirming.value = null; editing.value = c.id; draft.value = c.text;
  void focus(`[data-edit-field="${c.id}"]`);
}
function cancelEdit(id: number) {
  editing.value = null; error.value = '';
  void focus(`[data-edit="${id}"]`);
}
async function saveEdit(c: Comment) {
  if (busy.value) return;
  error.value = '';
  const value = checked(draft.value);
  if (value === null) return;
  busy.value = true;
  try {
    const next = await store.edit(props.source, props.path, c.id, value);
    update(props.comments.map((x) => (x.id === c.id ? next : x)));
    editing.value = null;
    message.value = t('comments.saved');
    void focus(`[data-edit="${c.id}"]`);
  } catch (e) { fail(e); }
  finally { busy.value = false; }
}
function onEditKey(e: KeyboardEvent, c: Comment) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(c.id); return; }
  if (sends(e)) { e.preventDefault(); void saveEdit(c); }
}

function askDelete(c: Comment) {
  error.value = ''; message.value = '';
  editing.value = null; confirming.value = c.id;
  void focus(`[data-keep="${c.id}"]`);
}
function keep(id: number) {
  confirming.value = null;
  void focus(`[data-delete="${id}"]`);
}
async function remove(c: Comment) {
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await store.remove(props.source, props.path, c.id);
    confirming.value = null;
    update(props.comments.filter((x) => x.id !== c.id));
    message.value = t('comments.deleted');
    void focus();
  } catch (e) { fail(e); }
  finally { busy.value = false; }
}
</script>

<template>
  <section
    ref="root"
    class="comment-thread"
  >
    <p
      role="status"
      class="visually-hidden"
    >
      {{ message }}
    </p>
    <ol
      v-if="comments.length"
      class="comment-list"
      :aria-label="t('comments.ofItem', { name })"
    >
      <li
        v-for="c in comments"
        :key="c.id"
        class="comment"
      >
        <p class="comment-head">
          <span class="comment-author">{{ author(c) }}</span>
          <time
            class="comment-time value-mono"
            :datetime="c.created"
          >{{ when(c.created) }}</time>
          <span
            v-if="c.edited"
            class="comment-edited"
          >{{ t('comments.edited') }}</span>
        </p>
        <form
          v-if="editing === c.id"
          class="comment-form"
          @submit.prevent="saveEdit(c)"
        >
          <label
            class="visually-hidden"
            :for="`${inputId}-${c.id}`"
          >{{ t('comments.editLabel') }}</label>
          <textarea
            :id="`${inputId}-${c.id}`"
            v-model="draft"
            class="fs-input comment-input"
            rows="3"
            :maxlength="MAX_COMMENT_LENGTH * 2"
            :data-edit-field="c.id"
            :aria-describedby="error ? `${hintId} ${errorId}` : hintId"
            :aria-invalid="error !== ''"
            enterkeyhint="send"
            @keydown="onEditKey($event, c)"
          />
          <span class="comment-actions">
            <button
              type="button"
              class="button"
              @click="cancelEdit(c.id)"
            >
              {{ t('comments.cancel') }}
            </button>
            <button
              type="submit"
              class="button primary"
              :disabled="busy || draft.trim() === ''"
            >
              {{ t('comments.save') }}
            </button>
          </span>
        </form>
        <p
          v-else
          class="comment-text"
        >
          {{ c.text }}
        </p>
        <span
          v-if="confirming === c.id"
          class="comment-confirm"
          role="group"
          :aria-label="t('comments.confirmDelete')"
        >
          <span>{{ t('comments.confirmDelete') }}</span>
          <button
            type="button"
            class="button"
            :data-keep="c.id"
            @click="keep(c.id)"
          >
            {{ t('comments.cancel') }}
          </button>
          <button
            type="button"
            class="button danger"
            :disabled="busy"
            @click="remove(c)"
          >
            {{ t('comments.delete') }}
          </button>
        </span>
        <span
          v-else-if="editing !== c.id && (c.mine || c.canDelete)"
          class="comment-actions"
        >
          <button
            v-if="c.mine"
            type="button"
            class="button"
            :data-edit="c.id"
            :aria-label="t('comments.editOne', { time: when(c.created) })"
            @click="startEdit(c)"
          >
            {{ t('comments.edit') }}
          </button>
          <button
            v-if="c.canDelete"
            type="button"
            class="button"
            :data-delete="c.id"
            :aria-label="c.mine ? t('comments.deleteMine', { time: when(c.created) })
              : t('comments.deleteOne', { author: memberName(c.author), time: when(c.created) })"
            @click="askDelete(c)"
          >
            {{ t('comments.delete') }}
          </button>
        </span>
      </li>
    </ol>
    <p
      v-else
      class="share-note"
    >
      {{ t('comments.none') }}
    </p>
    <form
      class="comment-form"
      @submit.prevent="send"
    >
      <label
        class="fs-section-heading comment-label"
        :for="inputId"
      >{{ t('comments.newLabel') }}</label>
      <textarea
        :id="inputId"
        ref="input"
        v-model="text"
        class="fs-input comment-input"
        rows="3"
        :maxlength="MAX_COMMENT_LENGTH * 2"
        :aria-describedby="error && editing === null ? `${hintId} ${errorId}` : hintId"
        :aria-invalid="error !== '' && editing === null"
        enterkeyhint="send"
        @keydown="onKey"
        @input="error = ''"
      />
      <p
        :id="hintId"
        class="share-note comment-hint"
      >
        {{ t('comments.hint') }}
      </p>
      <p
        v-if="error"
        :id="errorId"
        class="fs-field__error"
        role="alert"
      >
        {{ error }}
      </p>
      <span class="comment-actions">
        <button
          type="submit"
          class="button primary"
          :disabled="busy || text.trim() === ''"
        >
          {{ t('comments.send') }}
        </button>
      </span>
    </form>
  </section>
</template>
