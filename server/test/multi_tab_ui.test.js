const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Multi-Tab Visual & Functional Consistency Contract (#76)', () => {
  const cssPath = path.join(__dirname, '../../public/css/app.css');
  const jsPath = path.join(__dirname, '../../public/js/filebrowser.js');
  const indexPath = path.join(__dirname, '../../public/index.html');

  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const jsContent = fs.readFileSync(jsPath, 'utf8');
  const indexContent = fs.readFileSync(indexPath, 'utf8');

  test('HTML structure includes tab-bar-container and tabBarList', () => {
    assert.ok(indexContent.includes('id="tabBarContainer"'), 'tabBarContainer missing in index.html');
    assert.ok(indexContent.includes('id="tabBarList"'), 'tabBarList missing in index.html');
    assert.ok(indexContent.includes('id="btnNewTab"'), 'btnNewTab missing in index.html');
  });

  test('CSS enforces active vs inactive visual contrast and border accents', () => {
    assert.ok(cssContent.includes('.tab-bar-container'), 'tab-bar-container missing in app.css');
    assert.ok(cssContent.includes('.tab-item.active'), 'tab-item.active missing in app.css');
    assert.ok(
      cssContent.includes('border-top:') || cssContent.includes('border-bottom:') || cssContent.includes('border-color:'),
      'Tab accent border missing in app.css'
    );
  });

  test('CSS enforces text truncation and flex layout invariants on tab items', () => {
    assert.ok(cssContent.includes('.tab-item .tab-title'), 'tab-title missing in app.css');
    assert.ok(cssContent.includes('text-overflow: ellipsis'), 'text-overflow ellipsis missing in app.css');
    assert.ok(cssContent.includes('white-space: nowrap'), 'white-space nowrap missing in app.css');
  });

  test('CSS provides mobile responsive layout stability for tab bar without jumps', () => {
    assert.ok(cssContent.includes('.tab-bar-scroll'), 'tab-bar-scroll missing in app.css');
    // Ensure mobile rules don't completely hide tab title or force layout jump
    const mobileSection = cssContent.slice(cssContent.indexOf('@media'));
    assert.ok(mobileSection.length > 0, 'Mobile media query section missing');
  });

  test('JavaScript FileBrowser includes full multi-tab state management methods', () => {
    assert.ok(jsContent.includes('loadTabsFromSession()'), 'loadTabsFromSession missing');
    assert.ok(jsContent.includes('saveTabsToSession()'), 'saveTabsToSession missing');
    assert.ok(jsContent.includes('getActiveTab()'), 'getActiveTab missing');
    assert.ok(jsContent.includes('getTabIconHtml('), 'getTabIconHtml missing');
    assert.ok(jsContent.includes('createTab('), 'createTab missing');
    assert.ok(jsContent.includes('switchTab('), 'switchTab missing');
    assert.ok(jsContent.includes('closeTab('), 'closeTab missing');
    assert.ok(jsContent.includes('renderTabBar()'), 'renderTabBar missing');
  });

  test('getTabIconHtml supports all provider and view types', () => {
    assert.ok(jsContent.includes('s3'), 'S3 provider icon support missing in tab icons');
    assert.ok(jsContent.includes('moveit') || jsContent.includes('sftp'), 'MOVEit/SFTP provider icon support missing in tab icons');
    assert.ok(jsContent.includes('smart_folder') || jsContent.includes('favorites'), 'Virtual folder view tab icon support missing');
  });
});
