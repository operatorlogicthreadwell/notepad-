const { chromium } = require('playwright-core');
const path = require('path');
const UI_URL = 'file://' + path.resolve(__dirname, '..', '..', 'ui', 'index.html');
const CHROMIUM = process.env.CHROMIUM_PATH
  || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const SAMPLE_PDF = path.join(__dirname, '..', 'fixtures', 'sample.pdf');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
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

  // ===== 1. Console: resize + dock =====
  await t('console can be resized by dragging its edge', async () => {
    await page.locator('.menu[data-menu=run]').click();
    await page.locator('.mi[data-cmd=toggleConsole]').click();
    await page.waitForTimeout(200);
    const before = await page.locator('#console').evaluate((el) => el.offsetHeight);
    const box = await page.locator('#console-resizer').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 5 });
    await page.mouse.up();
    const after = await page.locator('#console').evaluate((el) => el.offsetHeight);
    assert(after > before + 80, `height ${before} -> ${after}`);
  });

  await t('console docks to the right side and back', async () => {
    await page.locator('#console-dock').click();
    await page.waitForTimeout(200);
    assert(await page.locator('#console.dock-right').count() === 1, 'not docked right');
    const parent = await page.locator('#console').evaluate((el) => el.parentElement.id);
    assert(parent === 'main-row', 'parent: ' + parent);
    await page.locator('#console-dock').click();
    await page.waitForTimeout(200);
    assert(await page.locator('#console.dock-right').count() === 0, 'still docked right');
    const parent2 = await page.locator('#console').evaluate((el) => el.parentElement.id);
    assert(parent2 === 'main-col', 'parent2: ' + parent2);
  });

  await t('console size and dock persist across reload', async () => {
    await page.locator('#console-dock').click();  // leave it docked right
    await page.waitForTimeout(1500);              // let the session save
    await page.reload();
    await page.waitForTimeout(2200);
    await page.locator('.menu[data-menu=run]').click();
    await page.locator('.mi[data-cmd=toggleConsole]').click();
    await page.waitForTimeout(300);
    assert(await page.locator('#console.dock-right').count() === 1, 'dock not restored');
    await page.locator('#console-dock').click();  // back to bottom for later tests
    await page.locator('#console-close').click();
  });

  // ===== 2. PDF annotation =====
  await t('open PDF, add a note via note mode', async () => {
    const fc = page.waitForEvent('filechooser');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=open]').click();
    await (await fc).setFiles(SAMPLE_PDF);
    await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 8000 });
    await page.locator('#pdf-mode-note').click();
    assert(await page.locator('#pdf-mode-note.on').count() === 1, 'note mode not on');
    const pg = await page.locator('.pdf-page[data-page="1"]').boundingBox();
    await page.mouse.click(pg.x + 200, pg.y + 150);
    await page.waitForTimeout(300);
    assert(await page.locator('#note-text').count() === 1, 'note editor not shown');
    await page.locator('#note-text').fill('check this paragraph');
    await page.locator('#modal-buttons button', { hasText: 'Save' }).click();
    await page.waitForTimeout(300);
    assert(await page.locator('.anno-pin').count() === 1, 'pin not drawn');
  });

  await t('add a highlight from a text selection', async () => {
    await page.locator('#pdf-mode-highlight').click();
    // select the text layer span programmatically, then mouseup in the pages area
    await page.evaluate(() => {
      const span = document.querySelector('.pdf-page[data-page="1"] .textLayer span');
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.getElementById('pdf-pages').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    assert(await page.locator('.anno-hl').count() >= 1, 'highlight not drawn');
  });

  await t('annotations survive closing and reopening the PDF', async () => {
    await page.waitForTimeout(400);
    await page.locator('.tab', { hasText: 'sample.pdf' }).locator('.close').click();
    await page.waitForTimeout(400);
    const fc = page.waitForEvent('filechooser');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=open]').click();
    await (await fc).setFiles(SAMPLE_PDF);
    await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 8000 });
    await page.waitForTimeout(600);
    assert(await page.locator('.anno-pin').count() === 1, 'pin not restored');
    assert(await page.locator('.anno-hl').count() >= 1, 'highlight not restored');
  });

  await t('editing a note updates it; delete removes it', async () => {
    await page.locator('.anno-pin').click();
    await page.waitForTimeout(200);
    const val = await page.locator('#note-text').inputValue();
    assert(val === 'check this paragraph', 'note text lost: ' + val);
    await page.locator('#modal-buttons button', { hasText: 'Delete' }).click();
    await page.waitForTimeout(300);
    assert(await page.locator('.anno-pin').count() === 0, 'pin not deleted');
  });

  await t('export annotated PDF produces a valid larger PDF', async () => {
    await page.locator('#pdf-export').click();
    await page.waitForTimeout(2500);
    const size = await page.evaluate(() => window.__lastExportSize || 0);
    assert(size > 500, 'export size: ' + size);
    if (await page.locator('#modal-backdrop:not(.hidden)').count()) await page.keyboard.press('Escape');
  });

  await t('removing the highlight via click works', async () => {
    await page.locator('.anno-hl').first().click();
    await page.waitForTimeout(200);
    await page.locator('#modal-buttons button', { hasText: 'Remove' }).click();
    await page.waitForTimeout(300);
    assert(await page.locator('.anno-hl').count() === 0, 'highlight not removed');
  });

  // ===== 3. Decide panel =====
  await t('Analyze Document streams into the Decide panel and renders markdown', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=new]').click();
    await page.locator('.CodeMirror').click();
    await page.keyboard.type('Plan: choose between SQLite and Postgres for v1.');
    await page.locator('.menu[data-menu=decide]').click();
    await page.locator('.mi[data-cmd=aiAnalyze]').click();
    await page.waitForTimeout(300);
    assert(await page.locator('#insight:not(.hidden)').count() === 1, 'panel not shown');
    assert((await page.locator('#insight-status').innerText()).includes('thinking'), 'no thinking status');
    await page.waitForTimeout(2500);
    assert((await page.locator('#insight-status').innerText()).includes('done'), 'not done');
    assert(await page.locator('#insight-out h2').count() >= 1, 'markdown not rendered');
  });

  await t('asking a question routes it through', async () => {
    await page.locator('#insight-q').fill('Which is cheaper?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    const txt = await page.locator('#insight-out').innerText();
    assert(txt.includes('Which is cheaper?'), 'question not routed: ' + txt);
  });

  await t('API settings dialog opens with model prefilled', async () => {
    await page.locator('#insight-settings').click();
    await page.waitForTimeout(300);
    assert((await page.locator('#ai-model').inputValue()) === 'claude-opus-4-8', 'model not prefilled');
    await page.keyboard.press('Escape');
  });

  await t('empty document is refused politely', async () => {
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=new]').click();
    await page.locator('.menu[data-menu=decide]').click();
    await page.locator('.mi[data-cmd=aiAnalyze]').click();
    await page.waitForTimeout(300);
    const body = await page.locator('#modal-body').innerText();
    assert(body.includes('empty'), 'no empty warning: ' + body);
    await page.keyboard.press('Escape');
  });

  if (errors.length) { console.log('JS ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  else console.log('No JS errors.');
  await browser.close();
})();
