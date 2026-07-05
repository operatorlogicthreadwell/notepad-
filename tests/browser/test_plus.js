const { chromium } = require('playwright-core');
const path = require('path');
const UI_URL = 'file://' + path.resolve(__dirname, '..', '..', 'ui', 'index.html') + '?edition=plus';
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

  await t('plus edition: no-ai class set, classic class not set', async () => {
    assert(await page.locator('body.no-ai').count() === 1, 'no-ai missing');
    assert(await page.locator('body.classic').count() === 0, 'classic wrongly set');
  });

  await t('Decide menu and panel hidden; AI shortcut inert', async () => {
    assert(await page.locator('.menu[data-menu=decide]').evaluate((el) =>
      getComputedStyle(el).display) === 'none', 'Decide menu visible');
    await page.locator('.CodeMirror').click();
    await page.keyboard.type('text');
    await page.keyboard.press('Control+Shift+A');
    await page.waitForTimeout(300);
    assert(await page.locator('#insight').evaluate((el) =>
      getComputedStyle(el).display) === 'none', 'insight opened');
  });

  await t('Apple Notes menu items are visible and the picker works', async () => {
    const display = await page.locator('.mi[data-cmd=openNote]').evaluate((el) =>
      getComputedStyle(el).display);
    assert(display !== 'none', 'openNote hidden');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=openNote]').click();
    await page.waitForTimeout(400);
    assert(await page.locator('.note-row').count() === 2, 'picker rows');
    await page.keyboard.press('Escape');
  });

  await t('PDFs open with viewer and annotation tools', async () => {
    const fc = page.waitForEvent('filechooser');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=open]').click();
    await (await fc).setFiles(SAMPLE_PDF);
    await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 8000 });
    assert(await page.locator('#pdf-container:not(.hidden)').count() === 1, 'viewer missing');
    const hl = await page.locator('#pdf-mode-highlight').evaluate((el) =>
      getComputedStyle(el).display);
    assert(hl !== 'none', 'annotation tools hidden');
  });

  await t('annotating works in plus edition', async () => {
    await page.locator('#pdf-mode-note').click();
    const pg = await page.locator('.pdf-page[data-page="1"]').boundingBox();
    await page.mouse.click(pg.x + 150, pg.y + 120);
    await page.waitForTimeout(300);
    await page.locator('#note-text').fill('plus edition note');
    await page.locator('#modal-buttons button', { hasText: 'Save' }).click();
    await page.waitForTimeout(300);
    assert(await page.locator('.anno-pin').count() === 1, 'pin not drawn');
  });

  if (errors.length) { console.log('JS ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  else console.log('No JS errors.');
  await browser.close();
})();
