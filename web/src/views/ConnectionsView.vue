<script setup lang="ts">
// "Cloud accounts" (#148): the member's own connections with their status, signing in again, unlinking (asked first,
// since shares into the account end), and one button per provider the shard offers. A failed consent comes back here
// with `?error=<code>`, shown once and then dropped from the URL. A new SharePoint connection comes back with
// `?pick=<id>` and opens the library picker (#151); until a library is picked, its row offers "Choose library".
import { nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ERROR_CODES, type Connection, type ErrorCode } from '@files/shared';
import { useConnectionsStore } from '../stores/connections.ts';
import { ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import LibraryPicker from '../components/LibraryPicker.vue';

const { t } = useI18n();
const route = useRoute(); const router = useRouter();
const connections = useConnectionsStore();
const status = ref('');
const alert = ref('');
const unlinking = ref<Connection | null>(null);
const picking = ref<Connection | null>(null);
const heading = ref<HTMLElement>();

const report = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  alert.value = t(`errors.${e.code}`);
};

onMounted(async () => {
  const code = route.query.error;
  // A denied consent is the member's own choice (#236 P10): a neutral note, not an alert.
  if (code === 'CONNECT_DENIED') status.value = t('errors.CONNECT_DENIED');
  else if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) alert.value = t(`errors.${code as ErrorCode}`);
  const pick = route.query.pick;
  if (code !== undefined || pick !== undefined) await router.replace({ query: {} });
  await connections.load();
  picking.value = connections.items.find((c) => c.id === pick && c.status === 'library') ?? null;
  // The stored status is what the last request saw; a live check per connection brings it up to date (#41).
  await Promise.all(connections.items.filter((c) => c.status !== 'unavailable').map((c) => connections.check(c.id).catch(report)));
});

async function signIn(body: { provider: string } | { connection: string }) {
  alert.value = '';
  try { await connections.authorize(body); }
  catch (e) { report(e); } // handled: shown in the alert line
}

/** The library is picked: the connection opens like any other. */
async function picked(c: Connection) {
  picking.value = null;
  await router.push(folderRoute(c.source, '/'));
}

async function unlink() {
  const c = unlinking.value!;
  unlinking.value = null;
  try {
    await connections.unlink(c.id);
    status.value = t('connections.unlinked', { account: c.account });
  } catch (e) { report(e); } // handled: shown in the alert line
  // The row and its button are gone; the focus goes to the heading instead of the page.
  await nextTick();
  if (!document.activeElement || document.activeElement === document.body) heading.value?.focus();
}
</script>

<template>
  <section class="page recent connections">
    <div class="toolbar">
      <h1
        ref="heading"
        class="view-title"
        tabindex="-1"
      >
        {{ $t('connections.title') }}
      </h1>
    </div>
    <p class="trash-note">
      {{ $t('connections.intro') }}
    </p>
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <p
      v-if="alert"
      role="alert"
    >
      {{ alert }}
    </p>
    <p v-if="!connections.loaded">
      {{ $t('folder.loading') }}
    </p>
    <p
      v-else-if="connections.error"
      role="alert"
    >
      {{ $t(`errors.${connections.error.code}`) }}
    </p>
    <template v-else>
      <p
        v-if="connections.items.length === 0"
        class="recent-empty"
      >
        {{ $t('connections.empty') }}
      </p>
      <table
        v-else
        class="file-list trash-list"
        :aria-label="$t('connections.title')"
      >
        <thead>
          <tr>
            <th scope="col">
              {{ $t('connections.columns.account') }}
            </th>
            <th scope="col">
              {{ $t('connections.columns.provider') }}
            </th>
            <th scope="col">
              {{ $t('connections.columns.status') }}
            </th>
            <th scope="col">
              <span class="visually-hidden">{{ $t('connections.columns.actions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in connections.items"
            :key="c.id"
          >
            <td class="name">
              <div class="name-inner">
                <span
                  class="icon icon-cloud"
                  aria-hidden="true"
                />
                <span>
                  {{ c.account }}
                  <span
                    v-if="c.library"
                    class="connection-library"
                  >{{ c.library }}</span>
                </span>
              </div>
            </td>
            <td class="origin">
              {{ c.providerName }}
            </td>
            <td
              class="origin connection-status"
              :data-status="c.status"
            >
              <span
                class="fs-pill"
                :data-tone="c.status === 'ok' ? 'ok' : c.status === 'reauth' ? 'danger' : undefined"
              >{{ $t(`connections.status.${c.status}`) }}</span>
            </td>
            <td class="actions">
              <RouterLink
                v-if="c.status === 'ok'"
                class="button"
                :to="folderRoute(c.source, '/')"
                :aria-label="$t('connections.openLabel', { account: c.account })"
              >
                {{ $t('connections.open') }}
              </RouterLink>
              <button
                v-if="c.status === 'library'"
                type="button"
                class="button primary"
                :aria-label="$t('connections.chooseLibraryLabel', { account: c.account })"
                @click="picking = c"
              >
                {{ $t('connections.chooseLibrary') }}
              </button>
              <button
                v-if="c.status === 'reauth'"
                type="button"
                class="button primary"
                :aria-label="$t('connections.reauthLabel', { account: c.account })"
                @click="signIn({ connection: c.id })"
              >
                {{ $t('connections.reauth') }}
              </button>
              <button
                type="button"
                class="button danger"
                :aria-label="$t('connections.unlinkLabel', { account: c.account })"
                @click="unlinking = c"
              >
                {{ $t('connections.unlink') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <h2 class="connections-add">
        {{ $t('connections.add') }}
      </h2>
      <p
        v-if="connections.providers.length === 0"
        class="recent-empty"
      >
        {{ $t('connections.noProviders') }}
      </p>
      <div
        v-else
        class="toolbar-actions"
      >
        <button
          v-for="p in connections.providers"
          :key="p.id"
          type="button"
          class="button"
          @click="signIn({ provider: p.id })"
        >
          {{ $t('connections.connect', { provider: p.name }) }}
        </button>
      </div>
    </template>
    <ConfirmDialog
      v-if="unlinking"
      :title="$t('connections.unlinkTitle', { account: unlinking.account })"
      :message="$t('connections.unlinkMessage', { provider: unlinking.providerName })"
      :confirm-label="$t('connections.unlink')"
      @confirm="unlink"
      @cancel="unlinking = null"
    />
    <LibraryPicker
      v-if="picking"
      :connection="picking"
      @picked="picked"
      @close="picking = null"
    />
  </section>
</template>
