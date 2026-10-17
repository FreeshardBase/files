import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

// #213: comments. `testuser` owns a folder with plan.txt and shares it read-only with `member`; the two have a
// conversation in the details drawer's "Comments" tab: Enter sends, Shift+Enter makes a new line, the text stays plain
// text, the list shows a count badge, the author edits their own comment and the owner deletes the grantee's. Both
// projects share one server; every test works in its own folder named after the project.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

/** A second browser context signed in as `login`, with the project's device. */
async function signedIn(browser: Browser, info: TestInfo, baseURL: string, login: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=%2F`);
  await expect(nav(p)).toBeVisible();
  return p;
}

async function openComments(page: Page, name: string): Promise<{ drawer: Locator; composer: Locator; thread: Locator }> {
  await row(page, name).getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const drawer = page.getByRole('dialog', { name: `Details ${name}`, exact: true });
  await expect(drawer).toBeVisible();
  // The tabs are one tab stop; the arrow key moves to "Comments" and selects it.
  const details = drawer.getByRole('tab', { name: /^Details$/ });
  await expect(details).toHaveAttribute('aria-selected', 'true');
  await details.focus();
  await page.keyboard.press('ArrowRight');
  const comments = drawer.getByRole('tab', { name: /^(Kommentare|Comments)/ });
  await expect(comments).toBeFocused();
  await expect(comments).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.getByRole('tabpanel', { name: /^(Kommentare|Comments)/ })).toBeVisible();
  return {
    drawer,
    composer: drawer.getByRole('textbox', { name: /^(Neuer Kommentar|New comment)$/ }),
    thread: drawer.getByRole('list', { name: new RegExp(`^(Kommentare zu|Comments on) ${name.replace('.', '\\.')}$`) }),
  };
}

test('the owner and a grantee have a conversation on a shared file', async ({ page, browser, baseURL }, info) => {
  const member = await signedIn(browser, info, baseURL!, 'member');
  const dir = `/zz-comments-${tag(info)}`;
  await page.goto('/');
  await expect(nav(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: dir } })).status()).toBe(201);
  expect((await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/plan.txt`)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: 'the plan' })).status()).toBe(201);
  const members = (await (await page.request.get('/api/v1/members')).json()).items as { id: string; displayName: string }[];
  const grantee = members.find((x) => x.displayName === 'Test Member')!;
  const shared = await page.request.post('/api/v1/shares', { headers, data: { source: 'home', path: dir, grantee: grantee.id, access: 'read' } });
  expect(shared.status()).toBe(201);
  const shareId = (await shared.json()).id as string;

  // The owner starts: Shift+Enter makes a new line, Enter sends, and the field is ready for the next one.
  await page.goto(`/home${dir}`);
  await expect(row(page, 'plan.txt')).toBeVisible();
  await expect(row(page, 'plan.txt').locator('.comment-badge')).toHaveCount(0);
  const owner = await openComments(page, 'plan.txt');
  await expect(owner.drawer.getByText(/Noch keine Kommentare|No comments yet/)).toBeVisible();
  await owner.composer.click();
  await page.keyboard.type('Hello, <b>see</b> https://example.com');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('can you check the plan?');
  await page.keyboard.press('Enter');
  const first = owner.thread.getByRole('listitem');
  await expect(first).toHaveCount(1);
  // Plain text: the line break is kept, markup and links stay text.
  expect(await first.locator('.comment-text').evaluate((e) => e.textContent)).toBe('Hello, <b>see</b> https://example.com\ncan you check the plan?');
  await expect(first.locator('b, a')).toHaveCount(0);
  await expect(first).toContainText(/^(Du|You)/);
  await expect(owner.composer).toHaveValue('');
  await expect(owner.composer).toBeFocused();
  await expect(owner.drawer.getByRole('tab', { name: /^(Kommentare|Comments) \(1\)$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(owner.drawer).toHaveCount(0);
  // The list counts the thread.
  await expect(row(page, 'plan.txt').locator('.comment-badge')).toContainText(/Ein Kommentar|One comment/);

  // The grantee sees the thread in the share, answers and fixes the answer.
  await member.goto(`/share:${shareId}`);
  await expect(row(member, 'plan.txt').locator('.comment-badge')).toContainText(/Ein Kommentar|One comment/);
  const them = await openComments(member, 'plan.txt');
  const ownerComment = them.thread.getByRole('listitem').first();
  await expect(ownerComment).toContainText('Test User');
  await expect(ownerComment).toContainText('can you check the plan?');
  // Neither edit nor delete on someone else's comment: from the tabs the next stop is the field.
  await expect(ownerComment.getByRole('button')).toHaveCount(0);
  await member.keyboard.press('Tab');
  await expect(them.composer).toBeFocused();
  await member.keyboard.type('Looks god to me');
  await member.keyboard.press('Enter');
  await expect(them.thread.getByRole('listitem')).toHaveCount(2);
  const reply = them.thread.getByRole('listitem').nth(1);
  await reply.getByRole('button', { name: /(Deinen Kommentar vom|Edit your comment from)/ }).click();
  const field = them.drawer.getByRole('textbox', { name: /^(Kommentar bearbeiten|Edit comment)$/ });
  await expect(field).toBeFocused();
  await field.fill('Looks good to me');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(reply.locator('.comment-text')).toHaveText('Looks good to me');
  await expect(reply).toContainText(/bearbeitet|edited/);
  await expect(reply.getByRole('button', { name: /(Deinen Kommentar vom|Edit your comment from)/ })).toBeFocused();

  // The owner sees the answer and, as the item's owner, deletes it after confirming in the row.
  await page.reload();
  await expect(row(page, 'plan.txt').locator('.comment-badge')).toContainText(/2 Kommentare|2 comments/);
  const again = await openComments(page, 'plan.txt');
  const answer = again.thread.getByRole('listitem').nth(1);
  await expect(answer).toContainText('Test Member');
  await expect(answer).toContainText('Looks good to me');
  await expect(answer.getByRole('button', { name: /bearbeiten|Edit/ })).toHaveCount(0);
  await answer.getByRole('button', { name: /(Kommentar von Test Member vom .* löschen|Delete the comment by Test Member from)/ }).click();
  const confirm = answer.getByRole('group', { name: /Diesen Kommentar löschen\?|Delete this comment\?/ });
  await expect(confirm.getByRole('button', { name: /^(Abbrechen|Cancel)$/ })).toBeFocused();
  await confirm.getByRole('button', { name: /^(Löschen|Delete)$/ }).click();
  await expect(again.thread.getByRole('listitem')).toHaveCount(1);
  await expect(again.composer).toBeFocused();
  await expect(again.drawer.getByRole('status')).toContainText(/Kommentar gelöscht|Comment deleted/);

  // The grantee's next look shows the thread as it is now.
  await member.reload();
  const last = await openComments(member, 'plan.txt');
  await expect(last.thread.getByRole('listitem')).toHaveCount(1);
  await expect(last.thread).not.toContainText('Looks good to me');
  await member.context().close();
});
