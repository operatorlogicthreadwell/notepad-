const { chromium } = require('playwright-core');
const path = require('path');
const UI_URL = 'file://' + path.resolve(__dirname, '..', '..', 'ui', 'index.html') + '?edition=classic';
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
  await page.evaluate(() => { localStorage.removeItem('npp-session'); localStorage.removeItem('npp-annos'); });
  await page.reload();
  await page.waitForTimeout(2200);

  const t = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  await t('classic edition flag applied', async () => {
    assert(await page.locator('body.classic').count() === 1, 'body.classic missing');
  });

  await t('Decide menu and panel are hidden', async () => {
    assert(await page.locator('.menu[data-menu=decide]').evaluate((el) =>
      getComputedStyle(el).display) === 'none', 'Decide menu visible');
    assert(await page.locator('#insight').evaluate((el) =>
      getComputedStyle(el).display) === 'none', 'insight panel visible');
  });

  await t('Apple Notes and PDF-as-text menu items hidden', async () => {
    for (const cmd of ['openNote', 'sendToNotes', 'pdfToText']) {
      const display = await page.locator('.mi[data-cmd=' + cmd + ']').evaluate((el) =>
        getComputedStyle(el).display);
      assert(display === 'none', cmd + ' visible');
    }
  });

  await t('AI keyboard shortcut is inert', async () => {
    await page.locator('.CodeMirror').click();
    await page.keyboard.type('some plan text');
    await page.keyboard.press('Control+Shift+A');
    await page.waitForTimeout(300);
    assert(await page.locator('#insight:not(.hidden)').evaluate(
      (el) => getComputedStyle(el).display).catch(() => 'none') === 'none'
      || await page.locator('#insight.hidden').count() === 1, 'insight opened');
  });

  await t('opening a PDF is refused with a friendly pointer to the AI edition', async () => {
    const fc = page.waitForEvent('filechooser');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=open]').click();
    await (await fc).setFiles(SAMPLE_PDF);
    await page.waitForTimeout(500);
    const body = await page.locator('#modal-body').innerText();
    assert(body.includes('Notepad-- AI'), 'no pointer dialog: ' + body);
    await page.keyboard.press('Escape');
    assert(await page.locator('.tab').count() === 1, 'a pdf tab was created');
  });

  await t('the Notepad++ core still works: edit, find, run console', async () => {
    await page.keyboard.press('Control+f');
    await page.locator('#find-input').fill('plan');
    await page.waitForTimeout(300);
    assert((await page.locator('#find-count').innerText()).includes('1 match'), 'find broken');
    await page.keyboard.press('Escape');
    await page.locator('.menu[data-menu=run]').click();
    await page.locator('.mi[data-cmd=toggleConsole]').click();
    assert(await page.locator('#console:not(.hidden)').count() === 1, 'console broken');
  });

  if (errors.length) { console.log('JS ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  else console.log('No JS errors.');
  await browser.close();
})();
