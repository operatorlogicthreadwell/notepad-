const { chromium } = require('playwright-core');
const path = require('path');
const UI_URL = 'file://' + path.resolve(__dirname, '..', '..', 'ui', 'index.html');
const CHROMIUM = process.env.CHROMIUM_PATH
  || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const SAMPLE_PDF = path.join(__dirname, '..', 'fixtures', 'sample.pdf');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(UI_URL);
  await page.evaluate(() => localStorage.removeItem('npp-session'));
  await page.reload();
  await page.waitForTimeout(2200);

  const t = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  await t('note picker lists notes with folders', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=openNote]').click();
    await page.waitForTimeout(400);
    assert(await page.locator('.note-row').count() === 2, 'rows: ' + await page.locator('.note-row').count());
    const txt = await page.locator('#note-list').innerText();
    assert(txt.includes('Groceries') && txt.includes('Ideas'), 'names: ' + txt);
  });

  await t('filter narrows the list', async () => {
    await page.locator('#note-filter').fill('groc');
    await page.waitForTimeout(200);
    assert(await page.locator('.note-row').count() === 1, 'filtered rows');
  });

  await t('clicking a note opens it as a tab', async () => {
    await page.locator('.note-row').first().click();
    await page.waitForTimeout(400);
    assert((await page.locator('.tab.active .tabname').innerText()) === 'Groceries', 'tab name');
    const val = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(val.includes('milk'), 'content: ' + val);
    assert((await page.locator('#st-enc').innerText()) === 'Apple Note', 'status encoding');
  });

  await t('opening the same note again reuses the tab', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=openNote]').click();
    await page.waitForTimeout(300);
    await page.locator('.note-row', { hasText: 'Groceries' }).click();
    await page.waitForTimeout(300);
    assert(await page.locator('.tab').count() === 1, 'duplicated tab');
  });

  await t('editing marks dirty; Cmd+S saves back into the note', async () => {
    await page.locator('.CodeMirror').click();
    await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      cm.setValue('Groceries v2\nmilk\nbread');
      cm.setCursor({line: 0, ch: 0});
    });
    await page.waitForTimeout(200);
    assert(await page.locator('.tab.dirty').count() === 1, 'not dirty after edit');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(400);
    assert(await page.locator('.tab.dirty').count() === 0, 'still dirty after save');
    assert((await page.locator('.tab.active .tabname').innerText()) === 'Groceries v2', 'name not updated');
    const stored = await page.evaluate(() => window.__lookupShim ? null : undefined);
    const shim = await page.evaluate(() => JSON.stringify((window.__debugNotes || [])));
  });

  await t('note tab survives reload with content and identity', async () => {
    await page.waitForTimeout(1200);
    await page.reload();
    await page.waitForTimeout(2200);
    assert((await page.locator('.tab.active .tabname').innerText()) === 'Groceries v2', 'restored name');
    assert((await page.locator('#st-enc').innerText()) === 'Apple Note', 'restored as note tab');
    const val = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(val.includes('bread'), 'restored content');
  });

  await t('Send Tab to Apple Notes creates a note from a plain tab', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=new]').click();
    await page.locator('.CodeMirror').click();
    await page.keyboard.type('Meeting minutes\n- ship it');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=sendToNotes]').click();
    await page.waitForTimeout(400);
    const body = await page.locator('#modal-body').innerText();
    assert(body.includes('Meeting minutes'), 'confirmation: ' + body);
    await page.keyboard.press('Escape');
  });

  await t('picker filter shows no-match state', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=openNote]').click();
    await page.waitForTimeout(300);
    await page.locator('#note-filter').fill('zzzzz');
    await page.waitForTimeout(200);
    assert((await page.locator('#note-list').innerText()).includes('No matching notes'), 'empty state');
    await page.keyboard.press('Escape');
  });

  if (errors.length) { console.log('JS ERRORS:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('No JS errors.');
  await browser.close();
})();
