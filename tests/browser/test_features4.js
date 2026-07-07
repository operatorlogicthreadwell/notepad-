const { chromium } = require("playwright-core");
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
let fails = 0;
const check = (name, ok) => { console.log((ok ? "PASS " : "FAIL ") + name); if (!ok) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + require("path").resolve(__dirname, "..", "..", "ui", "index.html"));
  // clear stored state so runs are deterministic
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(1800);

  const cm = (js) => page.evaluate(`(() => { const cm = document.querySelector('.CodeMirror').CodeMirror; return ${js}; })()`);

  // --- line ops ---
  await cm(`(cm.setValue('bbb\\naaa\\nccc'), cm.setCursor({line:0,ch:1}), 0)`);
  await page.evaluate(() => document.querySelector('.mi[data-cmd="duplicateLine"]').click());
  check("duplicate line", await cm(`cm.getValue()`) === "bbb\nbbb\naaa\nccc");

  await cm(`(cm.setValue('bbb\\naaa\\nccc'), cm.setCursor({line:1,ch:0}), 0)`);
  await page.evaluate(() => document.querySelector('.mi[data-cmd="moveLineUp"]').click());
  check("move line up", await cm(`cm.getValue()`) === "aaa\nbbb\nccc");

  await page.evaluate(() => document.querySelector('.mi[data-cmd="moveLineDown"]').click());
  check("move line down", await cm(`cm.getValue()`) === "bbb\naaa\nccc");

  await cm(`(cm.setValue('one\\n   two\\nthree'), cm.setCursor({line:0,ch:0}), 0)`);
  await page.evaluate(() => document.querySelector('.mi[data-cmd="joinLines"]').click());
  check("join lines", await cm(`cm.getValue()`) === "one two\nthree");

  await cm(`(cm.setValue('b\\nc\\na'), cm.setSelection({line:0,ch:0},{line:2,ch:1}), 0)`);
  await page.evaluate(() => document.querySelector('.mi[data-cmd="sortLines"]').click());
  check("sort lines", await cm(`cm.getValue()`) === "a\nb\nc");

  await cm(`(cm.setValue('hey'), cm.setSelection({line:0,ch:0},{line:0,ch:3}), 0)`);
  await page.evaluate(() => document.querySelector('.mi[data-cmd="upperCase"]').click());
  check("uppercase", await cm(`cm.getValue()`) === "HEY");

  await cm(`(cm.setValue('x = 1'), cm.setCursor({line:0,ch:0}), 0)`);
  await page.evaluate(() => {
    // set python so toggleComment knows the comment string
    document.querySelector('#language-menu .mi[data-lang="python"]').click();
    document.querySelector('.mi[data-cmd="toggleComment"]').click();
  });
  check("toggle comment (python)", await cm(`cm.getValue()`) === "# x = 1");
  await page.evaluate(() => document.querySelector('.mi[data-cmd="toggleComment"]').click());
  check("untoggle comment", await cm(`cm.getValue()`) === "x = 1");

  // auto-close brackets
  await cm(`(cm.setValue(''), cm.setCursor({line:0,ch:0}), cm.focus(), 0)`);
  await page.keyboard.type("(");
  check("auto-close brackets", await cm(`cm.getValue()`) === "()");

  // delete line ⇧⌘K
  await cm(`(cm.setValue('one\\ntwo'), cm.setCursor({line:0,ch:0}), cm.focus(), 0)`);
  await page.keyboard.press("Meta+Shift+K");
  check("delete line shortcut", await cm(`cm.getValue()`) === "two");

  // --- markdown preview ---
  await page.evaluate(() => document.querySelector('#language-menu .mi[data-lang="markdown"]').click());
  await cm(`(cm.setValue('# Title\\n\\n- item1\\n- item2\\n\\n\\u0060\\u0060\\u0060\\ncode here\\n\\u0060\\u0060\\u0060\\n> quote'), 0)`);
  await page.evaluate(() => document.querySelector('.mi[data-cmd="toggleMdPreview"]').click());
  await page.waitForTimeout(500);
  const previewVisible = await page.evaluate(() => !document.getElementById("mdpreview").classList.contains("hidden"));
  const previewHtml = await page.evaluate(() => document.getElementById("mdpreview").innerHTML);
  check("md preview visible", previewVisible);
  check("md preview renders h1/ul/pre/quote",
        previewHtml.includes("<h1>") && previewHtml.includes("<li>item2</li>") &&
        previewHtml.includes("<pre><code>code here") && previewHtml.includes("<blockquote>"));
  // live update
  await cm(`(cm.replaceRange('\\n**bold**', {line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length}), 0)`);
  await page.waitForTimeout(600);
  check("md preview live-updates", (await page.evaluate(() => document.getElementById("mdpreview").innerHTML)).includes("<b>bold</b>"));
  // switching to a plain tab hides it
  await page.evaluate(() => document.querySelector('.mi[data-cmd="new"]').click());
  check("md preview hides on non-md tab", await page.evaluate(() => document.getElementById("mdpreview").classList.contains("hidden")));

  // --- recent files menu (shim: shows placeholder) ---
  await page.evaluate(() => document.querySelector('#menubar .menu[data-menu="file"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  const recentText = await page.evaluate(() => document.getElementById("recent-menu").textContent);
  check("recent menu placeholder", recentText.includes("No Recent Files"));
  await page.mouse.click(600, 500);

  // --- tabs: ⌘2 switches, drag reorder API ---
  await page.evaluate(() => document.querySelector('.mi[data-cmd="new"]').click());
  await page.keyboard.press("Meta+1");
  const active1 = await page.evaluate(() => [...document.querySelectorAll("#tabbar .tab")].findIndex((t) => t.classList.contains("active")));
  await page.keyboard.press("Meta+2");
  const active2 = await page.evaluate(() => [...document.querySelectorAll("#tabbar .tab")].findIndex((t) => t.classList.contains("active")));
  check("cmd+1/2 switch tabs", active1 === 0 && active2 === 1);
  check("tabs draggable", await page.evaluate(() => document.querySelector("#tabbar .tab").draggable));

  // --- custom skin (shim path via localStorage) ---
  await page.evaluate(() => document.querySelector('#skin-menu .mi[data-skin="custom"]').click());
  await page.waitForTimeout(400);
  // dismiss the "created" info modal if present
  await page.evaluate(() => { const b = document.querySelector("#modal-buttons button"); if (b) b.click(); });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const styleInjected = await page.evaluate(() => !!document.getElementById("custom-skin-style"));
  check("custom skin applied", theme === "custom" && styleInjected);

  // --- find in files / open folder politely refuse in shim ---
  await page.evaluate(() => document.querySelector('.mi[data-cmd="findInFiles"]').click());
  const fifMsg = await page.evaluate(() => document.getElementById("modal-body").textContent);
  check("find in files shim message", fifMsg.includes("desktop app"));
  await page.evaluate(() => document.querySelector("#modal-buttons button").click());

  check("no JS errors", errors.length === 0);
  if (errors.length) console.log(errors.join("\n"));
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
