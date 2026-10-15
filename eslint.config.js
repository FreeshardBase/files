import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueI18n from '@intlify/eslint-plugin-vue-i18n';

const bannedBuffering = [
  { selector: "CallExpression[callee.property.name='arrayBuffer']", message: 'Stream instead of buffering (spec 3.2).' },
  { selector: "CallExpression[callee.object.name='Buffer'][callee.property.name='concat']", message: 'Stream instead of buffering (spec 3.2).' },
  { selector: "CallExpression[callee.name='readFile']", message: 'Stream instead of buffering (spec 3.2).' },
  { selector: "CallExpression[callee.property.name='readFile']", message: 'Stream instead of buffering (spec 3.2).' },
];

// Spec §3.8: every dialog uses <AppDialog> (focus trap, Esc, focus restore, scroll lock).
const onlyAppDialog = 'Dialogs must use <AppDialog> (web/src/components/AppDialog.vue).';
const bannedDialogScript = [
  { selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value='role'][arguments.1.value=/^(alert)?dialog$/]", message: onlyAppDialog },
  { selector: "Property[key.name='role'][value.value=/^(alert)?dialog$/]", message: onlyAppDialog },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['server/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...bannedBuffering],
      'no-restricted-properties': ['error',
        { object: 'process', property: 'exit', message: 'Only main.ts may exit.' }],
    },
  },
  { files: ['web/src/**/*.ts'], rules: { 'no-alert': 'error' } },
  // Browser globals (File, HTMLElement, ...) are checked by vue-tsc; eslint's no-undef only adds false positives here.
  { files: ['web/**/*.{ts,vue}'], rules: { 'no-undef': 'off' } },
  { files: ['server/src/main.ts'], rules: { 'no-restricted-properties': 'off' } },
  ...vue.configs['flat/recommended'],
  {
    files: ['web/src/**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: { 'vue-i18n': { localeDir: './web/src/i18n/*.json', messageSyntaxVersion: '^11.0.0' } },
    rules: {
      'vue/no-v-html': 'error',
      'vue/multi-word-component-names': ['error', { ignores: ['Breadcrumbs'] }],
      '@intlify/vue-i18n/no-raw-text': ['error', { ignorePattern: '^[\\s/·…–—|()\\-:]+$' }],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-alert': 'error',
      'vue/no-restricted-static-attribute': ['error',
        { key: 'role', value: 'dialog', message: onlyAppDialog }, { key: 'role', value: 'alertdialog', message: onlyAppDialog }],
      'vue/no-restricted-v-bind': ['error', { argument: 'role', message: `A bound role can hide a dialog. ${onlyAppDialog}` }],
      'vue/no-restricted-html-elements': ['error', { element: ['dialog'], message: onlyAppDialog }],
    },
  },
  { files: ['web/src/**/*.{ts,vue}'], rules: { 'no-restricted-syntax': ['error', ...bannedDialogScript] } },
  // The one place a dialog role may appear.
  {
    files: ['web/src/components/AppDialog.vue'],
    rules: { 'vue/no-restricted-static-attribute': 'off', 'vue/no-restricted-v-bind': 'off', 'vue/no-restricted-html-elements': 'off' },
  },
);
