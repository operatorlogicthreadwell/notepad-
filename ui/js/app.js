/* Notepad-- : application logic */
(function () {
  "use strict";

  // ======================================================================
  // Backend bridge — pywebview when wrapped, localStorage shim in a browser
  // ======================================================================
  const backend = {
    ready: null,
    api: null,
    isShim: false,

    init() {
      this.ready = new Promise((resolve) => {
        if (window.pywebview && window.pywebview.api) {
          this.api = window.pywebview.api;
          resolve();
          return;
        }
        let settled = false;
        window.addEventListener("pywebviewready", () => {
          if (settled) return;
          settled = true;
          this.api = window.pywebview.api;
          resolve();
        });
        setTimeout(() => {
          if (settled) return;
          settled = true;
          if (window.pywebview && window.pywebview.api) {
            this.api = window.pywebview.api;
          } else {
            this.isShim = true; // running in a plain browser (demo mode)
          }
          resolve();
        }, 1500);
      });
      return this.ready;
    },

    async openDialog() {
      if (!this.isShim) return this.api.open_dialog();
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.multiple = true;
        inp.onchange = async () => {
          const out = [];
          for (const f of inp.files) {
            if (/\.pdf$/i.test(f.name)) {
              out.push({ shimName: f.name, shimPdfBytes: new Uint8Array(await f.arrayBuffer()) });
            } else {
              out.push({ shimName: f.name, shimContent: await f.text() });
            }
          }
          resolve(out);
        };
        inp.click();
      });
    },

    async readFile(path) {
      if (!this.isShim) return this.api.read_file(path);
      return { error: "File system unavailable in browser demo" };
    },

    async readFileB64(path) {
      if (!this.isShim) return this.api.read_file_b64(path);
      return { error: "File system unavailable in browser demo" };
    },

    async saveDialog(name, dir) {
      if (!this.isShim) return this.api.save_dialog(name, dir || "");
      return name; // browser demo: pretend, then download
    },

    async writeFile(path, content) {
      if (!this.isShim) return this.api.write_file(path, content);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
      a.download = path.split("/").pop();
      a.click();
      return { ok: true };
    },

    async loadSession() {
      if (!this.isShim) return this.api.load_session();
      try { return JSON.parse(localStorage.getItem("npp-session")); }
      catch (e) { return null; }
    },

    async saveSession(s) {
      if (!this.isShim && !this.api) return { error: "not ready" };
      if (!this.isShim) return this.api.save_session(s);
      localStorage.setItem("npp-session", JSON.stringify(s));
      return { ok: true };
    },

    setTitle(t) {
      document.title = t;
      if (!this.isShim && this.api) this.api.set_title(t).catch?.(() => {});
    },
  };

  // ======================================================================
  // Languages
  // ======================================================================
  const LANGS = [
    { id: "text",       name: "Plain Text",  mime: null,                 exts: ["txt", "log", "ini", "cfg", "conf", "text"] },
    { id: "clike",      name: "C / C++ / Java", mime: "text/x-c++src",   exts: ["c", "h", "cpp", "hpp", "cc", "hh", "m", "mm", "java", "cs"] },
    { id: "css",        name: "CSS",         mime: "text/css",           exts: ["css", "scss", "less"] },
    { id: "html",       name: "HTML",        mime: "text/html",          exts: ["html", "htm", "xhtml"] },
    { id: "javascript", name: "JavaScript",  mime: "text/javascript",    exts: ["js", "mjs", "cjs", "jsx", "ts", "tsx"] },
    { id: "json",       name: "JSON",        mime: "application/json",   exts: ["json", "jsonc", "webmanifest"] },
    { id: "markdown",   name: "Markdown",    mime: "text/x-markdown",    exts: ["md", "markdown"] },
    { id: "python",     name: "Python",      mime: "text/x-python",      exts: ["py", "pyw"] },
    { id: "shell",      name: "Shell",       mime: "text/x-sh",          exts: ["sh", "bash", "zsh", "command"] },
    { id: "sql",        name: "SQL",         mime: "text/x-sql",         exts: ["sql"] },
    { id: "xml",        name: "XML",         mime: "application/xml",    exts: ["xml", "svg", "plist", "xsl"] },
    { id: "yaml",       name: "YAML",        mime: "text/x-yaml",        exts: ["yml", "yaml"] },
  ];
  const langById = (id) => LANGS.find((l) => l.id === id) || LANGS[0];
  const langForPath = (path) => {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return LANGS.find((l) => l.exts.includes(ext)) || LANGS[0];
  };

  // ======================================================================
  // State
  // ======================================================================
  const tabs = [];        // {id, path, name, doc, cleanGen, lang, encoding, eol, scroll}
  let activeTab = null;
  let untitledCounter = 0;
  let cm = null;
  const settings = { wrap: false, lineNumbers: true, fontSize: 13 };

  const $ = (sel) => document.querySelector(sel);
  const tabbar = $("#tabbar");

  // ======================================================================
  // Editor
  // ======================================================================
  function createEditor() {
    cm = CodeMirror($("#editor-container"), {
      value: "",
      mode: null,
      lineNumbers: settings.lineNumbers,
      lineWrapping: settings.wrap,
      styleActiveLine: true,
      matchBrackets: true,
      indentUnit: 4,
      tabSize: 4,
      viewportMargin: 20,
    });
    cm.on("changes", () => {
      if (!activeTab) return;
      updateTabDirty(activeTab);
      updateStatus();
      scheduleSessionSave();
      scheduleOverlayUpdate();
    });
    cm.on("cursorActivity", updateStatus);
  }

  function applyFontSize() {
    cm.getWrapperElement().style.fontSize = settings.fontSize + "px";
    cm.refresh();
  }

  // ======================================================================
  // Tabs
  // ======================================================================
  let nextId = 1;

  function newTab(opts = {}) {
    const lang = opts.lang || (opts.path ? langForPath(opts.path) : langById("text"));
    const tab = {
      id: nextId++,
      path: opts.path || null,
      name: opts.name || (opts.path ? opts.path.split("/").pop() : "new " + ++untitledCounter),
      doc: CodeMirror.Doc(opts.content || "", lang.mime),
      cleanGen: 0,
      forceDirty: !!opts.dirty,
      lang,
      encoding: opts.encoding || "UTF-8",
      eol: opts.eol || "\n",
      scroll: opts.scroll || null,
      cursor: opts.cursor || null,
    };
    tab.cleanGen = opts.dirty ? -1 : tab.doc.changeGeneration();
    tabs.push(tab);
    renderTabs();
    if (opts.activate !== false) activateTab(tab);
    return tab;
  }

  function isDirty(tab) {
    if (tab.type === "pdf") return false;
    return tab.cleanGen === -1 || !tab.doc.isClean(tab.cleanGen);
  }

  function activateTab(tab) {
    if (activeTab === tab) return;
    if (activeTab && activeTab.type !== "pdf") {
      activeTab.scroll = cm.getScrollInfo();
      activeTab.cursor = cm.getCursor();
    }
    activeTab = tab;
    if (tab.type === "pdf") {
      document.getElementById("editor-container").classList.add("hidden");
      document.getElementById("pdf-container").classList.remove("hidden");
      showPdfTab(tab);
    } else {
      document.getElementById("pdf-container").classList.add("hidden");
      document.getElementById("editor-container").classList.remove("hidden");
      cm.swapDoc(tab.doc);
      cm.setOption("mode", tab.lang.mime);
      cm.refresh();
      if (tab.cursor) { cm.setCursor(tab.cursor); tab.cursor = null; }
      if (tab.scroll) { cm.scrollTo(tab.scroll.left, tab.scroll.top); tab.scroll = null; }
    }
    renderTabs();
    updateStatus();
    updateTitle();
    scheduleOverlayUpdate();
    if (tab.type !== "pdf") cm.focus();
    scheduleSessionSave();
  }

  function closeTab(tab) {
    const idx = tabs.indexOf(tab);
    if (idx === -1) return;
    tabs.splice(idx, 1);
    if (tab.type === "pdf" && tab.doc) {
      try { tab.doc.destroy(); } catch (e) { /* already gone */ }
    }
    if (tabs.length === 0) {
      activeTab = null;
      newTab();
    } else if (activeTab === tab) {
      activeTab = null;
      activateTab(tabs[Math.min(idx, tabs.length - 1)]);
    } else {
      renderTabs();
    }
    scheduleSessionSave();
  }

  function renderTabs() {
    tabbar.textContent = "";
    for (const tab of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab === activeTab ? " active" : "") + (isDirty(tab) ? " dirty" : "");
      el.title = tab.path || tab.name;

      const dot = document.createElement("span");
      dot.className = "dot";
      const name = document.createElement("span");
      name.className = "tabname";
      name.textContent = tab.name;
      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "✕";
      close.title = "Close";
      close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab); });

      el.append(dot, name, close);
      el.addEventListener("mousedown", (e) => {
        if (e.target.closest(".close")) return;  // let the ✕ click land; activating re-renders the bar
        if (e.button === 1) { e.preventDefault(); closeTab(tab); }
        else if (e.button === 0) activateTab(tab);
      });
      tabbar.appendChild(el);
    }
    const act = tabbar.querySelector(".tab.active");
    if (act) act.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  function updateTabDirty(tab) {
    const idx = tabs.indexOf(tab);
    const el = tabbar.children[idx];
    if (el) el.classList.toggle("dirty", isDirty(tab));
    updateTitle();
  }

  function updateTitle() {
    if (!activeTab) return;
    const mark = isDirty(activeTab) ? "● " : "";
    backend.setTitle(mark + (activeTab.path || activeTab.name) + " - Notepad--");
  }

  // ======================================================================
  // File operations
  // ======================================================================
  function detectEol(text) {
    return /\r\n/.test(text) ? "\r\n" : "\n";
  }

  async function openFiles() {
    const picks = await backend.openDialog();
    for (const pick of picks || []) {
      if (pick && pick.shimName !== undefined) {   // browser demo mode
        if (pick.shimPdfBytes) {
          await openPdfBytes(pick.shimPdfBytes, null, pick.shimName);
        } else {
          newTab({ name: pick.shimName, content: pick.shimContent,
                   lang: langForPath(pick.shimName), eol: detectEol(pick.shimContent) });
        }
        continue;
      }
      await openPath(pick);
    }
  }

  async function openPath(path) {
    const existing = tabs.find((t) => t.path === path);
    if (existing) { activateTab(existing); return; }
    if (/\.pdf$/i.test(path)) {
      const res = await backend.readFileB64(path);
      if (res.error) { showAlert("Open failed", res.error); return; }
      await openPdfBytes(base64ToBytes(res.data), path, path.split("/").pop());
      return;
    }
    const res = await backend.readFile(path);
    if (res.error) { showAlert("Open failed", res.error); return; }
    const tab = newTab({
      path,
      content: res.content.replace(/\r\n/g, "\n"),
      encoding: res.encoding,
      eol: detectEol(res.content),
    });
    closeLoneUntitled(tab);
  }

  // Replace a single pristine untitled tab, like Notepad++ does
  function closeLoneUntitled(justOpened) {
    const lone = tabs.find((t) => t !== justOpened && t.type !== "pdf" &&
                                  !t.path && !isDirty(t) && t.doc.getValue() === "");
    if (lone && tabs.length === 2) closeTab(lone);
  }

  async function saveTab(tab, saveAs = false) {
    if (tab.type === "pdf") {
      showAlert("Read-only", "PDF tabs are view-only. Use File → Open PDF as Text to get an editable copy of the text.");
      return false;
    }
    let path = tab.path;
    if (!path || saveAs) {
      path = await backend.saveDialog(tab.name.includes(".") ? tab.name : tab.name + ".txt",
                                      tab.path ? tab.path.replace(/\/[^/]*$/, "") : "");
      if (!path) return false;
    }
    const content = tab.doc.getValue(tab.eol);
    const res = await backend.writeFile(path, content);
    if (res.error) { showAlert("Save failed", res.error); return false; }
    tab.path = path;
    tab.name = path.split("/").pop();
    tab.lang = langForPath(path);
    if (tab === activeTab) cm.setOption("mode", tab.lang.mime);
    tab.forceDirty = false;
    tab.cleanGen = tab.doc.changeGeneration();
    renderTabs();
    updateStatus();
    updateTitle();
    scheduleSessionSave();
    return true;
  }

  async function saveAll() {
    for (const tab of [...tabs]) {
      if (tab.type === "pdf") continue;
      if (isDirty(tab) || !tab.path) await saveTab(tab);
    }
  }

  // ======================================================================
  // PDF viewer (PDF.js) — read-only tabs with lazy page rendering
  // ======================================================================
  const pdfScroll = document.getElementById("pdf-scroll");
  const pdfPagesEl = document.getElementById("pdf-pages");
  let pdfObserver = null;

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  async function openPdfBytes(bytes, path, name, opts = {}) {
    if (typeof pdfjsLib === "undefined") {
      showAlert("PDF", "PDF.js failed to load.");
      return null;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    } catch (e) {
      showAlert("PDF open failed", e.message || String(e));
      return null;
    }
    const tab = {
      id: nextId++,
      type: "pdf",
      path,
      name,
      doc,
      numPages: doc.numPages,
      page: opts.page || 1,
      zoom: opts.zoom || null,       // null = fit width on first show
      pageTexts: null,               // [{text, offsets, items}] built on demand
      pageDivs: [],                  // per-page text-layer spans once rendered
      matches: null,
      matchIdx: -1,
      lang: { id: "pdf", name: "PDF Document", mime: null },
      encoding: "PDF",
      eol: "\n",
    };
    tabs.push(tab);
    renderTabs();
    if (opts.activate !== false) {
      activateTab(tab);
      closeLoneUntitled(tab);
    }
    return tab;
  }

  async function showPdfTab(tab) {
    pdfPagesEl.textContent = "";
    if (pdfObserver) pdfObserver.disconnect();
    tab.pageDivs = [];
    const first = await tab.doc.getPage(1);
    if (activeTab !== tab) return;   // user switched away mid-load
    const base = first.getViewport({ scale: 1 });
    if (!tab.zoom) tab.zoom = Math.max(0.25, (pdfScroll.clientWidth - 40) / base.width);
    for (let i = 1; i <= tab.numPages; i++) {
      const ph = document.createElement("div");
      ph.className = "pdf-page";
      ph.dataset.page = i;
      ph.style.width = Math.floor(base.width * tab.zoom) + "px";
      ph.style.height = Math.floor(base.height * tab.zoom) + "px";
      pdfPagesEl.appendChild(ph);
    }
    pdfObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) renderPdfPage(tab, +en.target.dataset.page);
      }
    }, { root: pdfScroll, rootMargin: "400px" });
    pdfPagesEl.querySelectorAll(".pdf-page").forEach((el) => pdfObserver.observe(el));
    updatePdfToolbar(tab);
    if (tab.page > 1) gotoPdfPage(tab, tab.page);
  }

  async function renderPdfPage(tab, n) {
    const ph = pdfPagesEl.querySelector('.pdf-page[data-page="' + n + '"]');
    if (!ph || ph.dataset.rendered || activeTab !== tab) return;
    ph.dataset.rendered = "1";
    const page = await tab.doc.getPage(n);
    if (activeTab !== tab) { delete ph.dataset.rendered; return; }
    const vp = page.getViewport({ scale: tab.zoom });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + "px";
    canvas.style.height = Math.floor(vp.height) + "px";
    ph.style.width = Math.floor(vp.width) + "px";
    ph.style.height = Math.floor(vp.height) + "px";
    ph.appendChild(canvas);
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    // Text layer: enables selection, copy, and search highlighting
    const tl = document.createElement("div");
    tl.className = "textLayer";
    tl.style.setProperty("--scale-factor", vp.scale);
    ph.appendChild(tl);
    const tc = await page.getTextContent();
    const divs = [];
    await pdfjsLib.renderTextLayer({
      textContentSource: tc, container: tl, viewport: vp, textDivs: divs,
    }).promise;
    tab.pageDivs[n] = divs;
    applyPdfHighlights(tab, n);
  }

  function updatePdfToolbar(tab) {
    document.getElementById("pdf-page-input").value = tab.page;
    document.getElementById("pdf-page-count").textContent = tab.numPages;
    document.getElementById("pdf-zoom-label").textContent = Math.round((tab.zoom || 1) * 100) + "%";
  }

  function gotoPdfPage(tab, n) {
    n = Math.min(Math.max(n, 1), tab.numPages);
    tab.page = n;
    const ph = pdfPagesEl.querySelector('.pdf-page[data-page="' + n + '"]');
    if (ph) pdfScroll.scrollTop = ph.offsetTop - 14;
    updatePdfToolbar(tab);
    updateStatus();
    scheduleSessionSave();
  }

  function setPdfZoom(tab, zoom) {
    tab.zoom = zoom ? Math.min(Math.max(zoom, 0.25), 5) : null;
    const page = tab.page;
    showPdfTab(tab).then(() => { gotoPdfPage(tab, page); });
  }

  function pdfTrackScroll() {
    if (!activeTab || activeTab.type !== "pdf") return;
    const tab = activeTab;
    const y = pdfScroll.scrollTop + pdfScroll.clientHeight / 2;
    let current = 1;
    for (const ph of pdfPagesEl.children) {
      if (ph.offsetTop <= y) current = +ph.dataset.page;
      else break;
    }
    if (current !== tab.page) {
      tab.page = current;
      updatePdfToolbar(tab);
      updateStatus();
      scheduleSessionSave();
    }
  }

  // ---- PDF text: extraction & search ----
  async function ensurePdfTexts(tab) {
    if (tab.pageTexts) return tab.pageTexts;
    const texts = [];
    for (let i = 1; i <= tab.numPages; i++) {
      const tc = await tab.doc.getPage(i).then((p) => p.getTextContent());
      let s = "";
      const offsets = [];
      for (const item of tc.items) {
        offsets.push(s.length);
        s += item.str + (item.hasEOL ? "\n" : "");
      }
      texts.push({ text: s, offsets, items: tc.items });
    }
    tab.pageTexts = texts;
    return texts;
  }

  async function pdfToText() {
    const tab = activeTab;
    if (!tab || tab.type !== "pdf") {
      showAlert("Open PDF as Text", "Open a PDF first, then use this to extract its text into an editable tab.");
      return;
    }
    const texts = await ensurePdfTexts(tab);
    const content = texts.map((p) => p.text.trimEnd()).join("\n\n");
    newTab({
      name: tab.name.replace(/\.pdf$/i, "") + ".txt",
      content,
      lang: langById("text"),
    });
  }

  async function pdfUpdateSearch() {
    const tab = activeTab;
    if (!tab || tab.type !== "pdf") return;
    pdfClearHighlights(tab);
    tab.matches = null;
    tab.matchIdx = -1;
    if (findbar.classList.contains("hidden")) return;
    const rx = queryAsRegex();
    if (!rx) return;
    const texts = await ensurePdfTexts(tab);
    if (activeTab !== tab) return;
    const matches = [];
    texts.forEach((pt, idx) => {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(pt.text)) && matches.length < 10000) {
        matches.push({ page: idx + 1, start: m.index, end: m.index + (m[0].length || 1) });
        if (m[0].length === 0) rx.lastIndex++;
      }
    });
    tab.matches = matches;
    findCount.textContent = matches.length === 0 ? "no matches"
      : matches.length + (matches.length === 1 ? " match" : " matches");
    findInput.classList.toggle("notfound", matches.length === 0);
    for (let n = 1; n <= tab.numPages; n++) applyPdfHighlights(tab, n);
  }

  function pdfClearHighlights(tab) {
    (tab.pageDivs || []).forEach((divs) => {
      if (divs) divs.forEach((d) => d.classList.remove("match-hl", "match-cur"));
    });
  }

  function applyPdfHighlights(tab, n) {
    const divs = tab.pageDivs[n];
    const pt = tab.pageTexts && tab.pageTexts[n - 1];
    if (!divs || !pt || !tab.matches) return;
    divs.forEach((d) => d.classList.remove("match-hl", "match-cur"));
    tab.matches.forEach((m, k) => {
      if (m.page !== n) return;
      for (let i = 0; i < pt.items.length; i++) {
        const s = pt.offsets[i];
        const e = s + pt.items[i].str.length;
        if (e > m.start && s < m.end && divs[i]) {
          divs[i].classList.add("match-hl");
          if (k === tab.matchIdx) divs[i].classList.add("match-cur");
        }
      }
    });
  }

  async function pdfFindStep(backwards) {
    const tab = activeTab;
    if (!tab || tab.type !== "pdf") return;
    if (!tab.matches) await pdfUpdateSearch();
    if (!tab.matches || tab.matches.length === 0) return;
    const len = tab.matches.length;
    tab.matchIdx = tab.matchIdx === -1
      ? (backwards ? len - 1 : 0)
      : (tab.matchIdx + (backwards ? -1 : 1) + len) % len;
    const m = tab.matches[tab.matchIdx];
    for (let n = 1; n <= tab.numPages; n++) applyPdfHighlights(tab, n);
    findCount.textContent = (tab.matchIdx + 1) + " of " + len;
    const cur = pdfPagesEl.querySelector(".match-cur");
    if (cur) cur.scrollIntoView({ block: "center" });
    else gotoPdfPage(tab, m.page);   // page not rendered yet; highlight lands after render
    tab.page = m.page;
    updatePdfToolbar(tab);
    updateStatus();
  }

  function setupPdfToolbar() {
    const tab = () => (activeTab && activeTab.type === "pdf" ? activeTab : null);
    document.getElementById("pdf-prev").addEventListener("click", () => { const t = tab(); if (t) gotoPdfPage(t, t.page - 1); });
    document.getElementById("pdf-next").addEventListener("click", () => { const t = tab(); if (t) gotoPdfPage(t, t.page + 1); });
    document.getElementById("pdf-zoom-in").addEventListener("click", () => { const t = tab(); if (t) setPdfZoom(t, t.zoom * 1.2); });
    document.getElementById("pdf-zoom-out").addEventListener("click", () => { const t = tab(); if (t) setPdfZoom(t, t.zoom / 1.2); });
    document.getElementById("pdf-zoom-fit").addEventListener("click", () => { const t = tab(); if (t) setPdfZoom(t, null); });
    document.getElementById("pdf-extract").addEventListener("click", pdfToText);
    document.getElementById("pdf-page-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const t = tab();
      const n = parseInt(e.target.value, 10);
      if (t && !isNaN(n)) gotoPdfPage(t, n);
    });
    pdfScroll.addEventListener("scroll", pdfTrackScroll);
  }

  // ======================================================================
  // Session persistence (Notepad++-style)
  // ======================================================================
  let sessionTimer = null;
  function scheduleSessionSave() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => backend.saveSession(buildSession()), 800);
  }

  function buildSession() {
    if (activeTab) {
      activeTab.liveCursor = cm.getCursor();
      activeTab.liveScroll = cm.getScrollInfo();
    }
    return {
      version: 1,
      untitledCounter,
      activeIndex: tabs.indexOf(activeTab),
      settings,
      tabs: tabs.map((t) => {
        if (t.type === "pdf") {
          return { type: "pdf", path: t.path, name: t.name, page: t.page, zoom: t.zoom };
        }
        const dirty = isDirty(t);
        const cur = t === activeTab ? t.liveCursor : t.cursor;
        const scr = t === activeTab ? t.liveScroll : t.scroll;
        return {
          path: t.path,
          name: t.name,
          lang: t.lang.id,
          encoding: t.encoding,
          eol: t.eol,
          dirty,
          // keep text for anything not safely on disk
          content: dirty || !t.path ? t.doc.getValue() : null,
          cursor: cur ? { line: cur.line, ch: cur.ch } : null,
          scroll: scr ? { left: scr.left, top: scr.top } : null,
        };
      }),
    };
  }

  // Called synchronously by Python right before the window closes.
  window.__getSessionJSON = () => {
    try { return JSON.stringify(buildSession()); }
    catch (e) { return null; }
  };
  window.addEventListener("beforeunload", () => backend.saveSession(buildSession()));

  async function restoreSession() {
    const s = await backend.loadSession();
    if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) { newTab(); return; }
    untitledCounter = s.untitledCounter || 0;
    Object.assign(settings, s.settings || {});
    for (const st of s.tabs) {
      if (st.type === "pdf") {
        if (!st.path) continue;                    // browser-demo PDFs can't be reopened
        const res = await backend.readFileB64(st.path);
        if (res.error) continue;                   // file vanished since last session
        await openPdfBytes(base64ToBytes(res.data), st.path, st.name,
                           { page: st.page, zoom: st.zoom, activate: false });
        continue;
      }
      let content = st.content;
      if (content == null && st.path) {
        const res = await backend.readFile(st.path);
        if (res.error) continue;             // file vanished since last session
        content = res.content.replace(/\r\n/g, "\n");
      }
      newTab({
        path: st.path,
        name: st.name,
        content: content || "",
        lang: langById(st.lang),
        encoding: st.encoding,
        eol: st.eol || "\n",
        dirty: !!st.dirty,
        cursor: st.cursor,
        scroll: st.scroll,
        activate: false,
      });
    }
    if (tabs.length === 0) { newTab(); return; }
    activateTab(tabs[Math.min(Math.max(s.activeIndex || 0, 0), tabs.length - 1)]);
  }

  // ======================================================================
  // Find / Replace
  // ======================================================================
  const findbar = $("#findbar");
  const findInput = $("#find-input");
  const replaceInput = $("#replace-input");
  const caseCB = $("#find-case");
  const regexCB = $("#find-regex");
  const findCount = $("#find-count");
  let searchOverlay = null;
  let overlayTimer = null;

  function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function currentQuery() {
    const q = findInput.value;
    if (!q) return null;
    if (regexCB.checked) {
      try { return new RegExp(q, caseCB.checked ? "g" : "gi"); }
      catch (e) { return null; }
    }
    return q;
  }

  function queryAsRegex() {
    const q = currentQuery();
    if (q === null) return null;
    if (typeof q === "string") return new RegExp(escapeRx(q), caseCB.checked ? "g" : "gi");
    return q;
  }

  function scheduleOverlayUpdate() {
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(updateOverlay, 120);
  }

  function updateOverlay() {
    if (searchOverlay) { cm.removeOverlay(searchOverlay); searchOverlay = null; }
    findCount.textContent = "";
    findInput.classList.remove("notfound");
    if (activeTab && activeTab.type === "pdf") { pdfUpdateSearch(); return; }
    if (findbar.classList.contains("hidden")) return;
    const rx = queryAsRegex();
    if (!rx) return;
    searchOverlay = {
      token(stream) {
        rx.lastIndex = stream.pos;
        const m = rx.exec(stream.string);
        if (m && m.index === stream.pos) {
          stream.pos += m[0].length || 1;
          return "searching";
        }
        if (m) stream.pos = m.index;
        else stream.skipToEnd();
        return null;
      },
    };
    cm.addOverlay(searchOverlay);
    // count matches (capped for huge files)
    let n = 0;
    const cursor = cm.getSearchCursor(currentQuery(), CodeMirror.Pos(cm.firstLine(), 0),
                                      { caseFold: !caseCB.checked });
    while (cursor.findNext() && n < 10000) n++;
    findCount.textContent = n === 0 ? "no matches" : n + (n === 1 ? " match" : " matches");
    if (n === 0) findInput.classList.add("notfound");
  }

  function findStep(backwards) {
    if (activeTab && activeTab.type === "pdf") { pdfFindStep(backwards); return; }
    const q = currentQuery();
    if (!q) return;
    const start = backwards ? cm.getCursor("from") : cm.getCursor("to");
    let cursor = cm.getSearchCursor(q, start, { caseFold: !caseCB.checked });
    let found = backwards ? cursor.findPrevious() : cursor.findNext();
    if (!found) {  // wrap around
      const edge = backwards
        ? CodeMirror.Pos(cm.lastLine(), cm.getLine(cm.lastLine()).length)
        : CodeMirror.Pos(cm.firstLine(), 0);
      cursor = cm.getSearchCursor(q, edge, { caseFold: !caseCB.checked });
      found = backwards ? cursor.findPrevious() : cursor.findNext();
    }
    if (found) {
      cm.setSelection(cursor.from(), cursor.to());
      cm.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 60);
      findInput.classList.remove("notfound");
    } else {
      findInput.classList.add("notfound");
    }
  }

  function replaceOne() {
    if (activeTab && activeTab.type === "pdf") { findCount.textContent = "PDF is read-only"; return; }
    const q = currentQuery();
    if (!q) return;
    const sel = cm.getSelection();
    const rx = queryAsRegex();
    if (sel && rx && new RegExp("^(?:" + rx.source + ")$", rx.flags.replace("g", "")).test(sel)) {
      const replacement = regexCB.checked
        ? sel.replace(new RegExp(rx.source, rx.flags.replace("g", "")), replaceInput.value)
        : replaceInput.value;
      cm.replaceSelection(replacement, "around");
    }
    findStep(false);
  }

  function replaceAll() {
    if (activeTab && activeTab.type === "pdf") { findCount.textContent = "PDF is read-only"; return; }
    const q = currentQuery();
    if (!q) return;
    let n = 0;
    cm.operation(() => {
      const cursor = cm.getSearchCursor(q, CodeMirror.Pos(cm.firstLine(), 0),
                                        { caseFold: !caseCB.checked });
      while (cursor.findNext()) {
        if (regexCB.checked) {
          const matched = cm.getRange(cursor.from(), cursor.to());
          const rx = new RegExp(queryAsRegex().source, caseCB.checked ? "" : "i");
          cursor.replace(matched.replace(rx, replaceInput.value));
        } else {
          cursor.replace(replaceInput.value);
        }
        n++;
        if (n > 100000) break;
      }
    });
    findCount.textContent = n + " replaced";
  }

  function showFindbar(withReplace) {
    findbar.classList.remove("hidden");
    const isPdf = activeTab && activeTab.type === "pdf";
    $("#replacerow").classList.toggle("hidden", !withReplace || isPdf);
    if (!isPdf) {
      const sel = cm.getSelection();
      if (sel && !sel.includes("\n")) findInput.value = sel;
    }
    findInput.focus();
    findInput.select();
    updateOverlay();
  }

  function hideFindbar() {
    findbar.classList.add("hidden");
    updateOverlay();
    if (activeTab && activeTab.type === "pdf") pdfClearHighlights(activeTab);
    else cm.focus();
  }

  // ======================================================================
  // Status bar
  // ======================================================================
  function updateStatus() {
    if (!activeTab) return;
    if (activeTab.type === "pdf") {
      $("#st-lang").textContent = "PDF Document (read-only)";
      $("#st-length").textContent = `pages : ${activeTab.numPages}`;
      $("#st-pos").textContent = `Page : ${activeTab.page} / ${activeTab.numPages}`;
      $("#st-eol").textContent = "—";
      $("#st-enc").textContent = "PDF";
      return;
    }
    const doc = cm.getDoc();
    const pos = cm.getCursor();
    const selChars = cm.getSelections().reduce((a, s) => a + s.length, 0);
    const selLines = cm.somethingSelected()
      ? cm.listSelections().reduce((a, r) => a + Math.abs(r.head.line - r.anchor.line) + (r.head.ch !== r.anchor.ch || r.head.line !== r.anchor.line ? 1 : 0), 0)
      : 0;
    $("#st-lang").textContent = activeTab.lang.name;
    $("#st-length").textContent = `length : ${doc.getValue().length}    lines : ${doc.lineCount()}`;
    $("#st-pos").textContent = `Ln : ${pos.line + 1}    Col : ${pos.ch + 1}    Sel : ${selChars} | ${selLines}`;
    $("#st-eol").textContent = activeTab.eol === "\r\n" ? "Windows (CR LF)" : "Unix (LF)";
    $("#st-enc").textContent = activeTab.encoding;
  }

  // ======================================================================
  // Menus
  // ======================================================================
  function buildLanguageMenu() {
    const menu = $("#language-menu");
    for (const lang of LANGS) {
      const mi = document.createElement("div");
      mi.className = "mi check";
      mi.dataset.lang = lang.id;
      mi.textContent = lang.name;
      mi.addEventListener("click", () => setLanguage(lang));
      menu.appendChild(mi);
    }
  }

  function setLanguage(lang) {
    if (!activeTab || activeTab.type === "pdf") return;
    activeTab.lang = lang;
    cm.setOption("mode", lang.mime);
    updateStatus();
    scheduleSessionSave();
  }

  function syncMenuChecks() {
    $("#mi-wrap").classList.toggle("checked", settings.wrap);
    $("#mi-linenumbers").classList.toggle("checked", settings.lineNumbers);
    $("#tb-wrap").classList.toggle("on", settings.wrap);
    document.querySelectorAll("#language-menu .mi").forEach((mi) => {
      mi.classList.toggle("checked", activeTab && mi.dataset.lang === activeTab.lang.id);
    });
  }

  function setupMenubar() {
    const menus = document.querySelectorAll("#menubar .menu");
    let openMenu = null;
    const close = () => { if (openMenu) { openMenu.classList.remove("open"); openMenu = null; } };
    menus.forEach((m) => {
      m.addEventListener("mousedown", (e) => {
        if (e.target.closest(".mi")) return;
        e.preventDefault();
        if (openMenu === m) { close(); return; }
        close();
        syncMenuChecks();
        m.classList.add("open");
        openMenu = m;
      });
      m.addEventListener("mouseenter", () => {
        if (openMenu && openMenu !== m) {
          openMenu.classList.remove("open");
          syncMenuChecks();
          m.classList.add("open");
          openMenu = m;
        }
      });
    });
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest("#menubar")) close();
    });
    document.addEventListener("click", (e) => {
      const mi = e.target.closest(".mi[data-cmd]");
      if (mi) { close(); runCommand(mi.dataset.cmd); }
      else if (e.target.closest("#language-menu .mi")) close();
    });
    document.querySelectorAll("#toolbar .tb").forEach((btn) => {
      btn.addEventListener("click", () => runCommand(btn.dataset.cmd));
    });
  }

  // ======================================================================
  // Modal dialogs
  // ======================================================================
  const backdrop = $("#modal-backdrop");
  function showModal(title, bodyHTML, buttons) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHTML;
    const bb = $("#modal-buttons");
    bb.textContent = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.addEventListener("click", () => { hideModal(); b.onClick && b.onClick(); });
      bb.appendChild(btn);
    }
    backdrop.classList.remove("hidden");
    const inp = $("#modal-body input");
    if (inp) { inp.focus(); inp.select(); }
  }
  function hideModal() {
    backdrop.classList.add("hidden");
    if (!activeTab || activeTab.type !== "pdf") cm.focus();
  }
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) hideModal(); });

  function showAlert(title, msg) {
    showModal(title, "<div>" + escapeHtml(msg) + "</div>", [{ label: "OK" }]);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function gotoPageDialog() {
    const tab = activeTab;
    if (!tab || tab.type !== "pdf") return;
    showModal("Go to Page", '<label>Page number (1 - ' + tab.numPages + ') :</label><input id="goto-input" type="text">',
      [{ label: "Go", onClick: doGoto }, { label: "Cancel" }]);
    $("#goto-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); hideModal(); doGoto(); }
    });
    function doGoto() {
      const n = parseInt($("#goto-input") ? $("#goto-input").value : "", 10);
      if (!isNaN(n)) gotoPdfPage(tab, n);
    }
  }

  function gotoLineDialog() {
    showModal("Go to Line", '<label>Line number (1 - ' + cm.lineCount() + ') :</label><input id="goto-input" type="text">',
      [{ label: "Go", onClick: doGoto }, { label: "Cancel" }]);
    $("#goto-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); hideModal(); doGoto(); }
    });
    function doGoto() {
      const n = parseInt($("#goto-input") ? $("#goto-input").value : "", 10);
      if (!isNaN(n)) {
        const line = Math.min(Math.max(n, 1), cm.lineCount()) - 1;
        cm.setCursor({ line, ch: 0 });
        cm.scrollIntoView({ line, ch: 0 }, 80);
      }
    }
  }

  function aboutDialog() {
    showModal("About Notepad--",
      "<div style='text-align:center'><b style='font-size:16px'>Notepad--</b><br><br>" +
      "A Notepad++-style text editor for macOS.<br>HTML wrapped in Python (pywebview + CodeMirror).<br><br>" +
      "Tabs · syntax highlighting · regex find &amp; replace · session restore</div>",
      [{ label: "OK" }]);
  }

  // ======================================================================
  // Commands & shortcuts
  // ======================================================================
  async function clipboardCut() {
    const sel = cm.getSelection();
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel); cm.replaceSelection(""); }
    catch (e) { showAlert("Clipboard", "Use ⌘X to cut."); }
  }
  async function clipboardCopy() {
    const sel = cm.getSelection();
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel); }
    catch (e) { showAlert("Clipboard", "Use ⌘C to copy."); }
  }
  async function clipboardPaste() {
    try { cm.replaceSelection(await navigator.clipboard.readText()); }
    catch (e) { showAlert("Clipboard", "Use ⌘V to paste."); }
  }

  function runCommand(cmd) {
    const isPdf = activeTab && activeTab.type === "pdf";
    if (isPdf) {
      // Editor-only commands are no-ops on a read-only PDF tab
      if (["undo", "redo", "cut", "paste", "selectAll", "toggleWrap", "toggleLineNumbers"].includes(cmd)) return;
      if (cmd === "copy") {
        const sel = String(window.getSelection());
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return;
      }
      if (cmd === "zoomIn") { setPdfZoom(activeTab, activeTab.zoom * 1.2); return; }
      if (cmd === "zoomOut") { setPdfZoom(activeTab, activeTab.zoom / 1.2); return; }
      if (cmd === "zoomReset") { setPdfZoom(activeTab, null); return; }
      if (cmd === "gotoLine") { gotoPageDialog(); return; }
    }
    const actions = {
      new: () => newTab(),
      open: openFiles,
      save: () => activeTab && saveTab(activeTab),
      saveAs: () => activeTab && saveTab(activeTab, true),
      saveAll,
      closeTab: () => activeTab && closeTab(activeTab),
      closeAll: () => { for (const t of [...tabs]) closeTab(t); },
      undo: () => cm.undo(),
      redo: () => cm.redo(),
      cut: clipboardCut,
      copy: clipboardCopy,
      paste: clipboardPaste,
      selectAll: () => cm.execCommand("selectAll"),
      find: () => showFindbar(false),
      replace: () => showFindbar(true),
      findNext: () => findStep(false),
      findPrev: () => findStep(true),
      gotoLine: gotoLineDialog,
      toggleWrap: () => {
        settings.wrap = !settings.wrap;
        cm.setOption("lineWrapping", settings.wrap);
        syncMenuChecks();
        scheduleSessionSave();
      },
      toggleLineNumbers: () => {
        settings.lineNumbers = !settings.lineNumbers;
        cm.setOption("lineNumbers", settings.lineNumbers);
        syncMenuChecks();
        scheduleSessionSave();
      },
      zoomIn: () => { settings.fontSize = Math.min(settings.fontSize + 1, 36); applyFontSize(); scheduleSessionSave(); },
      zoomOut: () => { settings.fontSize = Math.max(settings.fontSize - 1, 8); applyFontSize(); scheduleSessionSave(); },
      zoomReset: () => { settings.fontSize = 13; applyFontSize(); scheduleSessionSave(); },
      pdfToText,
      about: aboutDialog,
    };
    const fn = actions[cmd];
    if (fn) fn();
    if (!isPdf && !["find", "replace", "gotoLine", "about"].includes(cmd)) cm.focus();
  }

  function setupShortcuts() {
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if (!backdrop.classList.contains("hidden")) { hideModal(); e.preventDefault(); return; }
        if (!findbar.classList.contains("hidden")) { hideFindbar(); e.preventDefault(); return; }
      }
      if (!mod) return;
      const k = e.key.toLowerCase();
      const map = {
        n: "new", o: "open", w: "closeTab", g: e.shiftKey ? "findPrev" : "findNext",
        l: "gotoLine", "=": "zoomIn", "+": "zoomIn", "-": "zoomOut", "0": "zoomReset",
      };
      let cmd = null;
      if (k === "s") cmd = e.shiftKey ? "saveAs" : "save";
      else if (k === "f") cmd = e.altKey ? "replace" : "find";
      else if (map[k] && !(k === "n" && e.shiftKey)) cmd = map[k];
      if (cmd) { e.preventDefault(); runCommand(cmd); }
    });

    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey); }
    });
    replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); replaceOne(); }
    });
    findInput.addEventListener("input", scheduleOverlayUpdate);
    caseCB.addEventListener("change", updateOverlay);
    regexCB.addEventListener("change", updateOverlay);
    $("#btn-find-next").addEventListener("click", () => findStep(false));
    $("#btn-find-prev").addEventListener("click", () => findStep(true));
    $("#btn-find-close").addEventListener("click", hideFindbar);
    $("#btn-replace").addEventListener("click", replaceOne);
    $("#btn-replace-all").addEventListener("click", replaceAll);
  }

  // ======================================================================
  // Boot
  // ======================================================================
  async function boot() {
    createEditor();
    buildLanguageMenu();
    setupMenubar();
    setupShortcuts();
    setupPdfToolbar();
    await backend.init();
    await restoreSession();
    cm.setOption("lineWrapping", settings.wrap);
    cm.setOption("lineNumbers", settings.lineNumbers);
    applyFontSize();
    syncMenuChecks();
    updateStatus();
    cm.focus();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
