<script setup lang="ts">
// The admin's page (#156): every member with their shard usage and quota; the admin sets a quota (MB or GB, as the app
// shows sizes: powers of 1000) or removes it. The server answers FORBIDDEN to anyone but the admin, so the page then
// shows only that.
import { onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MemberUsage } from '@files/shared';
import { useMembersStore } from '../stores/storage.ts';
import { ApiFailure } from '../api/client.ts';
import { formatSize, intlLocale } from '../format.ts';

const UNITS = { MB: 1e6, GB: 1e9 } as const;
type Unit = keyof typeof UNITS;

const { t, locale } = useI18n();
const members = useMembersStore();
const status = ref('');
const alert = ref('');
// The form of each row: what the admin typed, the unit, and whether it was refused.
type Form = { amount: string; unit: Unit; invalid: boolean };
const forms = reactive<Record<string, Form>>({});
watch(() => members.items, (items) => {
  for (const m of items) forms[m.id] ??= { amount: '', unit: 'GB', invalid: false };
}, { immediate: true });
const formOf = (id: string): Form => forms[id]!;
onMounted(() => { void members.load(); });

const size = (n: number) => formatSize(n, intlLocale(locale.value));

async function save(m: MemberUsage, quotaBytes: number | null) {
  status.value = ''; alert.value = '';
  try {
    const r = await members.setQuota(m.id, quotaBytes);
    status.value = r.quota === null ? t('members.removed', { name: r.displayName })
      : t('members.saved', { name: r.displayName, quota: size(r.quota) });
  } catch (e) { // handled: an API refusal is shown in the alert line; anything else is rethrown
    if (!(e instanceof ApiFailure)) throw e;
    alert.value = t(`errors.${e.code}`);
  }
}

function submit(m: MemberUsage) {
  const f = formOf(m.id);
  const n = Number(f.amount.trim().replace(',', '.'));
  f.invalid = f.amount.trim() === '' || !Number.isFinite(n) || n < 0;
  if (f.invalid) return;
  void save(m, Math.round(n * UNITS[f.unit]));
}
</script>

<template>
  <section class="page recent members">
    <div class="toolbar">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('members.title') }}
      </h1>
    </div>
    <p class="trash-note">
      {{ $t('members.intro') }}
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
    <p v-if="!members.loaded">
      {{ $t('folder.loading') }}
    </p>
    <p
      v-else-if="members.error"
      role="alert"
    >
      {{ $t(`errors.${members.error.code}`) }}
    </p>
    <table
      v-else
      class="file-list trash-list members-list"
      :aria-label="$t('members.title')"
    >
      <thead>
        <tr>
          <th scope="col">
            {{ $t('members.columns.member') }}
          </th>
          <th scope="col">
            {{ $t('members.columns.used') }}
          </th>
          <th scope="col">
            {{ $t('members.columns.quota') }}
          </th>
          <th scope="col">
            {{ $t('members.columns.actions') }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="m in members.items"
          :key="m.id"
        >
          <td class="name">
            <div class="name-inner members-name">
              <span>
                {{ m.displayName }}
                <span
                  v-if="m.role === 'admin'"
                  class="fs-pill members-role"
                >{{ $t('members.admin') }}</span>
              </span>
              <span
                v-if="m.email"
                class="members-email"
                :title="m.email"
              >{{ m.email }}</span>
            </div>
          </td>
          <td class="num size">
            {{ size(m.used) }}
          </td>
          <td class="num date members-quota">
            <span
              v-if="m.quota === null"
              class="num-word"
            >{{ $t('members.noQuota') }}</span>
            <template v-else>
              {{ size(m.quota) }}
            </template>
          </td>
          <td class="actions">
            <form
              class="members-form"
              novalidate
              @submit.prevent="submit(m)"
            >
              <input
                v-model="formOf(m.id).amount"
                class="fs-input members-amount"
                type="text"
                inputmode="decimal"
                :aria-label="$t('members.amountLabel', { name: m.displayName })"
                :aria-invalid="formOf(m.id).invalid ? 'true' : undefined"
                :aria-describedby="formOf(m.id).invalid ? `quota-error-${m.id}` : undefined"
              >
              <select
                v-model="formOf(m.id).unit"
                class="fs-input members-unit"
                :aria-label="$t('members.unitLabel', { name: m.displayName })"
              >
                <option value="MB">
                  {{ $t('members.units.MB') }}
                </option>
                <option value="GB">
                  {{ $t('members.units.GB') }}
                </option>
              </select>
              <button
                type="submit"
                class="button"
                :aria-label="$t('members.setLabel', { name: m.displayName })"
              >
                {{ $t('members.set') }}
              </button>
              <button
                v-if="m.quota !== null"
                type="button"
                class="button"
                :aria-label="$t('members.removeLabel', { name: m.displayName })"
                @click="save(m, null)"
              >
                {{ $t('members.remove') }}
              </button>
            </form>
            <span
              v-if="formOf(m.id).invalid"
              :id="`quota-error-${m.id}`"
              class="fs-field__error members-error"
            >{{ $t('members.invalid') }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
