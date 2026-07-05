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
  await page.evaluate(() => localStorage.removeItem('npp-session'));
  await page.reload();
  await page.waitForTimeout(2200);

  const t = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  await t('open a PDF via File > Open', async () => {
    const fcPromise = page.waitForEvent('filechooser');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=open]').click();
    const fc = await fcPromise;
    await fc.setFiles(SAMPLE_PDF);
    await page.waitForTimeout(1500);
    assert((await page.locator('.tab.active .tabname').innerText()) === 'sample.pdf', 'tab name');
    assert(await page.locator('#pdf-container:not(.hidden)').count() === 1, 'pdf pane not shown');
    assert(await page.locator('#editor-container.hidden').count() === 1, 'editor not hidden');
  });

  await t('page 1 rendered with canvas and text layer', async () => {
    await page.waitForSelector('.pdf-page[data-page="1"] canvas', { timeout: 8000 });
    await page.waitForSelector('.pdf-page[data-page="1"] .textLayer span', { timeout: 8000 });
    const txt = await page.locator('.pdf-page[data-page="1"] .textLayer').innerText();
    assert(txt.includes('Hello PDF'), 'text layer: ' + txt);
  });

  await t('status bar shows PDF info', async () => {
    assert((await page.locator('#st-lang').innerText()).includes('PDF Document'), 'lang');
    assert((await page.locator('#st-pos').innerText()).includes('Page : 1 / 2'), 'pos: ' + await page.locator('#st-pos').innerText());
    assert((await page.locator('#pdf-page-count').innerText()) === '2', 'page count');
  });

  await t('next-page button navigates to page 2', async () => {
    await page.locator('#pdf-next').click();
    await page.waitForTimeout(800);
    assert((await page.locator('#st-pos').innerText()).includes('Page : 2 / 2'), 'pos after next');
    await page.waitForSelector('.pdf-page[data-page="2"] canvas', { timeout: 8000 });
  });

  await t('zoom in changes scale', async () => {
    const before = await page.locator('#pdf-zoom-label').innerText();
    await page.locator('#pdf-zoom-in').click();
    await page.waitForTimeout(1000);
    const after = await page.locator('#pdf-zoom-label').innerText();
    assert(parseInt(after) > parseInt(before), `zoom ${before} -> ${after}`);
    await page.waitForSelector('.pdf-page canvas', { timeout: 8000 });
  });

  await t('find bar searches PDF text', async () => {
    await page.keyboard.press('Control+f');
    await page.locator('#find-input').fill('World');
    await page.waitForTimeout(600);
    const count = await page.locator('#find-count').innerText();
    assert(count.includes('1 match'), 'count: ' + count);
    await page.locator('#btn-find-next').click();
    await page.waitForTimeout(800);
    assert(await page.locator('.textLayer .match-cur').count() >= 1, 'no current-match highlight');
    assert((await page.locator('#st-pos').innerText()).includes('Page : 2'), 'did not jump to page 2');
  });

  await t('replace is refused on PDF', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Alt+f');
    await page.waitForTimeout(200);
    // replace row should be hidden for PDFs
    assert(await page.locator('#replacerow.hidden').count() === 1, 'replace row visible on pdf');
    await page.keyboard.press('Escape');
  });

  await t('go to page dialog (Cmd+L)', async () => {
    await page.keyboard.press('Control+l');
    await page.locator('#goto-input').fill('1');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    assert((await page.locator('#st-pos').innerText()).includes('Page : 1'), 'not on page 1');
    const align = await page.evaluate(() => {
      const sc = document.getElementById('pdf-scroll').getBoundingClientRect();
      const ph = document.querySelector('.pdf-page[data-page="1"]').getBoundingClientRect();
      return Math.round(ph.top - sc.top);
    });
    assert(align >= 0 && align <= 30, 'page misaligned after goto: ' + align + 'px');
  });

  await t('Open as Text extracts into editable tab', async () => {
    await page.locator('#pdf-extract').click();
    await page.waitForTimeout(1000);
    assert((await page.locator('.tab.active .tabname').innerText()) === 'sample.txt', 'txt tab name');
    assert(await page.locator('#editor-container:not(.hidden)').count() === 1, 'editor not shown');
    const val = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(val.includes('Hello PDF page one') && val.includes('World of page two'), 'content: ' + val);
  });

  await t('switching between text and pdf tabs swaps panes', async () => {
    await page.locator('.tab', { hasText: 'sample.pdf' }).click();
    await page.waitForTimeout(400);
    assert(await page.locator('#pdf-container:not(.hidden)').count() === 1, 'pdf pane');
    await page.locator('.tab', { hasText: 'sample.txt' }).click();
    await page.waitForTimeout(400);
    assert(await page.locator('#editor-container:not(.hidden)').count() === 1, 'editor pane');
    const st = await page.locator('#st-lang').innerText();
    assert(st === 'Plain Text', 'status lang: ' + st);
  });

  await t('typing still works in text tab after pdf viewing', async () => {
    await page.locator('.CodeMirror').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('edited!');
    const val = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(val === 'edited!', 'typing failed: ' + val);
  });

  await t('closing pdf tab is safe', async () => {
    const pdfTab = page.locator('.tab', { hasText: 'sample.pdf' });
    await pdfTab.locator('.close').click();
    await page.waitForTimeout(300);
    assert(await page.locator('.tab').count() === 1, 'tab count: ' + await page.locator('.tab').count() + ' names: ' + (await page.locator('.tabname').allInnerTexts()).join(','));
    assert(await page.locator('#editor-container:not(.hidden)').count() === 1, 'editor pane');
  });

  const realErrors = errors.filter(e => !/worker|Warning/i.test(e));
  if (realErrors.length) { console.log('\nJS ERRORS:'); realErrors.forEach(e => console.log('  ' + e)); }
  else console.log('\nNo JS errors.' + (errors.length ? ' (' + errors.length + ' worker warnings ignored)' : ''));
  await browser.close();
})();
