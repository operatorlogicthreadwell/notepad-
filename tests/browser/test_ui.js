const { chromium } = require('playwright-core');
const path = require('path');
const UI_URL = 'file://' + path.resolve(__dirname, '..', '..', 'ui', 'index.html');
const CHROMIUM = process.env.CHROMIUM_PATH
  || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const SAMPLE_PDF = path.join(__dirname, '..', 'fixtures', 'sample.pdf');


(async () => {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(UI_URL);
  // wait past the 1.5s pywebview timeout so the browser shim activates
  await page.waitForTimeout(2200);

  const t = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  await t('editor created', async () => {
    assert(await page.locator('.CodeMirror').count() === 1, 'no CodeMirror');
  });

  await t('one untitled tab on fresh start', async () => {
    assert(await page.locator('.tab').count() === 1, 'tab count');
    assert((await page.locator('.tabname').innerText()) === 'new 1', 'tab name');
  });

  await t('typing marks tab dirty and updates status', async () => {
    await page.locator('.CodeMirror').click();
    await page.keyboard.type('def hello():\nprint("hi")');
    assert(await page.locator('.tab.dirty').count() === 1, 'not dirty');
    const len = await page.locator('#st-length').innerText();
    assert(len.includes('lines : 2'), 'status lines wrong: ' + len);
  });

  await t('auto-indent happened (python-ish)', async () => {
    const text = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(text.startsWith('def hello():'), 'content: ' + JSON.stringify(text));
  });

  await t('new tab via menu File > New', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=new]').click();
    assert(await page.locator('.tab').count() === 2, 'tab count after new');
    assert((await page.locator('.tab.active .tabname').innerText()) === 'new 2', 'active tab name');
  });

  await t('switch back to tab 1', async () => {
    await page.locator('.tab').first().click();
    const val = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(val.includes('def hello'), 'doc not swapped');
  });

  await t('language menu sets syntax highlighting', async () => {
    await page.locator('.menu[data-menu=language]').click();
    await page.locator('#language-menu .mi[data-lang=python]').click();
    assert((await page.locator('#st-lang').innerText()) === 'Python', 'status lang');
    await page.waitForTimeout(300);
    assert(await page.locator('.cm-keyword').count() > 0, 'no keyword highlight');
  });

  await t('find bar: regex search finds and counts', async () => {
    await page.keyboard.press('Control+f'); // shim: ctrl works as mod
    await page.locator('#find-input').fill('pri.t');
    await page.locator('#find-regex').check();
    await page.waitForTimeout(300);
    const count = await page.locator('#find-count').innerText();
    assert(count.includes('1 match'), 'count: ' + count);
    await page.locator('#btn-find-next').click();
    const sel = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getSelection());
    assert(sel === 'print', 'selection: ' + sel);
  });

  await t('replace all works', async () => {
    await page.locator('#btn-find-close').click();
    await page.keyboard.press('Control+Alt+f');
    await page.locator('#find-input').fill('hi');
    await page.locator('#find-regex').uncheck();
    await page.locator('#replace-input').fill('hello world');
    await page.locator('#btn-replace-all').click();
    const val = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(val.includes('hello world'), 'replace failed: ' + val);
    await page.keyboard.press('Escape');
  });

  await t('go to line dialog', async () => {
    await page.keyboard.press('Control+l');
    await page.locator('#goto-input').fill('1');
    await page.keyboard.press('Enter');
    const line = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getCursor().line);
    assert(line === 0, 'cursor line ' + line);
  });

  await t('word wrap toggle', async () => {
    await page.locator('#tb-wrap').click();
    const wrap = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getOption('lineWrapping'));
    assert(wrap === true, 'wrap not on');
    assert(await page.locator('#tb-wrap.on').count() === 1, 'toolbar not toggled');
  });

  await t('session persists across reload (shim localStorage)', async () => {
    await page.waitForTimeout(1200); // let debounced save fire
    await page.reload();
    await page.waitForTimeout(2200);
    assert(await page.locator('.tab').count() === 2, 'tabs restored: ' + await page.locator('.tab').count());
    const val = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('npp-session'));
      return s.tabs.map(t => t.content).join('|');
    });
    assert(val.includes('hello world'), 'content not in session');
    const restored = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(restored.includes('hello world'), 'editor content not restored: ' + restored);
    const wrap = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getOption('lineWrapping'));
    assert(wrap === true, 'wrap setting not restored');
  });

  await t('closing dirty tab shows Save/Don\'t Save/Cancel; Cancel keeps it', async () => {
    const before = await page.locator('.tab').count();
    await page.locator('.tab.dirty .close').first().click();
    await page.waitForTimeout(300);
    assert(await page.locator('#modal-backdrop:not(.hidden)').count() === 1, 'no confirm dialog');
    await page.locator('#modal-buttons button', { hasText: 'Cancel' }).click();
    await page.waitForTimeout(200);
    assert(await page.locator('.tab').count() === before, 'tab closed despite Cancel');
  });

  await t('Escape on the confirm dialog also cancels', async () => {
    const before = await page.locator('.tab').count();
    await page.locator('.tab.dirty .close').first().click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert(await page.locator('.tab').count() === before, 'tab closed despite Escape');
  });

  await t('close all: Don\'t Save discards and leaves one fresh tab', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=closeAll]').click();
    await page.waitForTimeout(300);
    assert(await page.locator('#modal-backdrop:not(.hidden)').count() === 1, 'no confirm dialog');
    await page.locator('#modal-buttons button', { hasText: "Don't Save" }).click();
    await page.waitForTimeout(500);
    assert(await page.locator('.tab').count() === 1, 'tab count ' + await page.locator('.tab').count());
    assert(await page.locator('#modal-backdrop:not(.hidden)').count() === 0, 'dialog still open');
  });


  if (errors.length) { console.log('\nJS ERRORS:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('\nNo JS errors.');
  await browser.close();
})();
