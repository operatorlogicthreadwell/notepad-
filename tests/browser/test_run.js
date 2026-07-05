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

  await t('console hidden by default, Run menu present', async () => {
    assert(await page.locator('#console.hidden').count() === 1, 'console visible');
    assert(await page.locator('.menu[data-menu=run]').count() === 1, 'no Run menu');
  });

  await t('toggle console via menu', async () => {
    await page.locator('.menu[data-menu=run]').click();
    await page.locator('.mi[data-cmd=toggleConsole]').click();
    await page.waitForTimeout(200);
    assert(await page.locator('#console:not(.hidden)').count() === 1, 'console not shown');
  });

  await t('streamed output renders with stream colors', async () => {
    await page.evaluate(() => {
      window.__runOutput('$ python3 demo.py\n', 'cmd');
      window.__runOutput('hello world\n', 'out');
      window.__runOutput('Traceback...\n', 'err');
      window.__runDone(1);
    });
    const txt = await page.locator('#console-out').innerText();
    assert(txt.includes('hello world') && txt.includes('Traceback'), 'output: ' + txt);
    assert(await page.locator('#console-out .con-err').count() === 1, 'stderr not colored');
    assert((await page.locator('#console-status').innerText()).includes('exit 1'), 'status');
    assert(await page.locator('#console-status.fail').count() === 1, 'fail class');
  });

  await t('clear button empties output', async () => {
    await page.locator('#console-clear').click();
    assert((await page.locator('#console-out').innerText()).trim() === '', 'not cleared');
  });

  await t('shell command box reports demo-mode error gracefully', async () => {
    await page.locator('#console-cmd').fill('echo hi');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const txt = await page.locator('#console-out').innerText();
    assert(txt.includes('desktop app'), 'no shim message: ' + txt);
  });

  await t('Cmd+R on unsaved tab opens save flow first', async () => {
    await page.locator('.CodeMirror').click();
    await page.keyboard.type('print(1)');
    await page.keyboard.press('Control+r');
    await page.waitForTimeout(400);
    // shim saveDialog auto-answers, then writeFile downloads, then runFile errors into console
    const txt = await page.locator('#console-out').innerText();
    assert(txt.includes('desktop app'), 'run did not reach console: ' + txt);
  });

  await t('console close button hides it', async () => {
    await page.locator('#console-close').click();
    assert(await page.locator('#console.hidden').count() === 1, 'still visible');
  });

  if (errors.length) { console.log('JS ERRORS:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('No JS errors.');
  await browser.close();
})();
