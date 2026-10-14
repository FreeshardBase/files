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
  { files: ['server/src/main.ts'], rules: { 'no-restricted-properties': 'off' } },
  ...vue.configs['flat/recommended'],
  {
    files: ['web/src/**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: { 'vue-i18n': { localeDir: './web/src/i18n/*.json', messageSyntaxVersion: '^11.0.0' } },
    rules: {
      'vue/no-v-html': 'error',
      '@intlify/vue-i18n/no-raw-text': ['error', { ignorePattern: '^[\\s/·…–—|()\\-:]+$' }],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-alert': 'error',
    },
  },
);
