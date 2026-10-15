// @vitest-environment node
// Every dialog goes through <AppDialog> (spec §3.8): the lint config rejects a dialog role or element anywhere else.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });
const errors = async (code: string, file: string) =>
  (await eslint.lintText(code, { filePath: `${root}web/src/${file}` }))[0]!.messages.filter((m) => m.severity === 2);
const sfc = (template: string) => `<script setup lang="ts">\n</script>\n\n<template>\n  ${template}\n</template>\n`;

describe('dialog lint', () => {
  it.each([
    ['a static role', '<div role="dialog" />'],
    ['an alertdialog role', '<div role="alertdialog" />'],
    ['a bound role', `<div :role="'dialog'" />`],
    ['a native <dialog>', '<dialog />'],
  ])('rejects %s in a component', async (_, template) => {
    const found = await errors(sfc(template), 'components/SomeDialog.vue');
    expect(found.map((m) => m.message).join('\n')).toMatch(/AppDialog/);
  });
  it('rejects a dialog role set from script', async () => {
    const found = await errors("export const f = (el: HTMLElement) => el.setAttribute('role', 'dialog');\n", 'views/x.ts');
    expect(found.map((m) => m.message).join('\n')).toMatch(/AppDialog/);
  });
  it('allows the role inside AppDialog.vue itself', async () => {
    const found = await errors(sfc('<div\n    role="dialog"\n    aria-modal="true"\n  />'), 'components/AppDialog.vue');
    expect(found).toEqual([]);
  });
});
