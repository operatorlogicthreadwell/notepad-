const { chromium } = require('playwright-core');
const path = require('path');
const UI_URL = 'file://' + path.resolve(__dirname, '..', '..', 'ui', 'index.html');
const CHROMIUM = process.env.CHROMIUM_PATH
  || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const t = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  // --- corrupted session must not brick the app ---
  await page.goto(UI_URL);
  await page.evaluate(() => localStorage.setItem('npp-session',
    '{"version":1,"tabs":[{"type":"pdf"},{"lang":"nope","content":42},{"noteId":123}],"activeIndex":99,"settings":{"fontSize":"huge"}}'));
  await page.reload();
  await page.waitForTimeout(2500);
  await t('boots despite corrupted session fields', async () => {
    assert(await page.locator('.CodeMirror').count() === 1, 'editor missing');
    assert(await page.locator('.tab').count() >= 1, 'no tabs');
  });

  await t('boots despite unparseable session', async () => {
    // A separate context with an init script: the main page's unload flush
    // would immediately repair any garbage we plant in its own localStorage
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('npp-session', 'THIS IS NOT JSON {{{'));
    const p2 = await ctx.newPage();
    const errs2 = [];
    p2.on('pageerror', (e) => errs2.push(e.message));
    await p2.goto(UI_URL);
    await p2.waitForTimeout(2500);
    assert(await p2.locator('.tab').count() === 1, 'no fresh tab');
    assert(errs2.length === 0, 'boot errors: ' + errs2[0]);
    await ctx.close();
  });

  // --- pathological text ---
  await t('emoji/astral chars and a 200k-char line: no crash', async () => {
    await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      cm.setValue('\u{1F600}\u{1F468}‍\u{1F469}é\n' + 'x'.repeat(200000) + '\n​ end');
      cm.setCursor({ line: 0, ch: 2 });
    });
    await page.waitForTimeout(400);
    assert((await page.locator('#st-length').innerText()).includes('length'), 'status broken');
  });

  await t('100k-line document: 50 cursor moves stay fast (length cache)', async () => {
    await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      cm.setValue(Array.from({ length: 100000 }, (_, i) => 'line ' + i).join('\n'));
    });
    const ms = await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) cm.setCursor({ line: i * 100, ch: 0 });
      return performance.now() - t0;
    });
    assert(ms < 2000, '50 cursor moves took ' + ms + 'ms');
  });

  // --- find/replace abuse ---
  await t('invalid/degenerate regexes never crash', async () => {
    await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('aaaaaaaaaaaaaaaaaaaa!'));
    await page.keyboard.press('Control+f');
    await page.locator('#find-regex').check();
    for (const q of ['(', '[z-a]', '(a+)+$', '.*.*.*.*!', '\\\\', '', 'a*']) {
      await page.locator('#find-input').fill(q);
      await page.waitForTimeout(250);
    }
    await page.locator('#btn-find-next').click();
    await page.keyboard.press('Escape');
  });

  await t('non-regex replacement with $ patterns stays literal', async () => {
    await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('pay day'));
    await page.keyboard.press('Control+Alt+f');
    await page.locator('#find-regex').uncheck();
    await page.locator('#find-input').fill('day');
    await page.locator('#replace-input').fill('$100 & more $&');
    await page.locator('#btn-replace-all').click();
    await page.waitForTimeout(200);
    const val = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert(val === 'pay $100 & more $&', 'literal replacement mangled: ' + JSON.stringify(val));
    await page.keyboard.press('Escape');
  });

  // --- broken PDFs ---
  await t('corrupt PDF: error dialog, app survives', async () => {
    const fc = page.waitForEvent('filechooser');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=open]').click();
    await (await fc).setFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 garbage') });
    await page.waitForTimeout(1500);
    assert(await page.locator('#modal-backdrop:not(.hidden)').count() === 1, 'no error dialog');
    await page.keyboard.press('Escape');
    assert(await page.locator('.CodeMirror').count() === 1, 'app died');
  });

  await t('zero-byte PDF handled', async () => {
    const fc = page.waitForEvent('filechooser');
    await page.locator('.menu[data-menu=file]').click();
    await page.locator('.mi[data-cmd=open]').click();
    await (await fc).setFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
    await page.waitForTimeout(1200);
    if (await page.locator('#modal-backdrop:not(.hidden)').count()) await page.keyboard.press('Escape');
    assert(await page.locator('.CodeMirror').count() === 1, 'app died');
  });

  // --- monkey test: 250 seeded-random actions, zero JS errors allowed ---
  await t('monkey test: 250 random UI actions, no JS errors', async () => {
    const before = errors.length;
    const T = { timeout: 700 };   // short per-action timeout: absent elements must not stall the run
    const actions = [
      () => page.locator('.menu[data-menu=file]').click(T),
      () => page.locator('.mi[data-cmd=new]').click(T),
      () => page.keyboard.press('Escape'),
      () => page.keyboard.type('abc('),
      () => page.keyboard.press('Control+f'),
      () => page.locator('#find-input').fill('a', T),
      () => page.keyboard.press('Control+z'),
      () => page.locator('.tab').first().click(T),
      () => page.locator('.tab').last().click(T),
      () => page.locator('#tb-wrap').click(T),
      () => page.locator('.menu[data-menu=view]').click(T),
      () => page.locator('.menu[data-menu=run]').click(T),
      () => page.locator('.mi[data-cmd=toggleConsole]').click(T),
      () => page.locator('.CodeMirror').click(T),
      () => page.keyboard.press('Control+l'),
      () => page.locator('#goto-input').fill('5', T),
      () => page.keyboard.press('Enter'),
      // close tab via the menu, not Ctrl+W (which closes the *browser's* tab in headless)
      () => page.locator('.menu[data-menu=file]').click(T)
              .then(() => page.locator('.mi[data-cmd=closeTab]').click(T)),
      () => page.locator('#modal-buttons button').first().click(T),
    ];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 250; i++) {
      try { await actions[Math.floor(rnd() * actions.length)](); }
      catch (e) { /* blocked/missing element is fine; JS errors are not */ }
      if (i % 50 === 0) await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    const fresh = errors.slice(before);
    assert(fresh.length === 0, fresh.length + ' JS errors, first: ' + fresh[0]);
    assert(await page.locator('.CodeMirror').count() === 1, 'editor gone');
  });

  if (errors.length) { console.log('\nALL JS ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  else console.log('\nNo JS errors anywhere.');
  await browser.close();
})();
