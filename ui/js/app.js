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

    async writeFile(path, content, encoding, expectedMtime) {
      if (!this.isShim) return this.api.write_file(path, content, encoding || "UTF-8",
                                                   expectedMtime == null ? null : expectedMtime);
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

    async runFile(path, lang) {
      if (this.isShim) return { error: "Running scripts needs the desktop app (python3 app.py).\n" };
      return this.api.run_file(path, lang);
    },
    async runCommand(cmd, cwd) {
      if (this.isShim) return { error: "Running commands needs the desktop app (python3 app.py).\n" };
      return this.api.run_command(cmd, cwd);
    },
    async runStop() {
      if (this.isShim) return { ok: false };
      return this.api.run_stop();
    },
    async startupFiles() {
      if (this.isShim || !this.api.get_startup_files) return [];
      try { return (await this.api.get_startup_files()) || []; }
      catch (e) { return []; }
    },

    async getEdition() {
      if (!this.isShim) {
        try { return (await this.api.get_edition()).edition || "ai"; }
        catch (e) { return "ai"; }
      }
      return new URLSearchParams(location.search).get("edition") || "ai";
    },

    async writeFileB64(path, b64) {
      if (!this.isShim) return this.api.write_file_b64(path, b64);
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([arr], { type: "application/pdf" }));
      a.download = path.split("/").pop();
      a.click();
      return { ok: true };
    },

    // PDF annotations — sidecar storage keyed by file path
    async annosLoad(key) {
      if (!this.isShim) return this.api.annotations_get(key);
      try { return { data: JSON.parse(localStorage.getItem("npp-annos") || "{}")[key] || null }; }
      catch (e) { return { data: null }; }
    },
    async annosSave(key, data) {
      if (!this.isShim) return this.api.annotations_save(key, data);
      const all = JSON.parse(localStorage.getItem("npp-annos") || "{}");
      if (data && (data.highlights.length || data.notes.length)) all[key] = data;
      else delete all[key];
      localStorage.setItem("npp-annos", JSON.stringify(all));
      return { ok: true };
    },

    // Decision intelligence — provider-agnostic on the Mac, canned demo here
    _shimAiCfg: { provider: "anthropic", base_url: "",
                  models: { anthropic: "claude-opus-4-8", openai: "gpt-5", custom: "llama3.3" } },
    async aiConfig() {
      if (!this.isShim) return this.api.get_ai_config();
      const c = this._shimAiCfg;
      return { provider: c.provider, model: c.models[c.provider], models: { ...c.models },
               has_key: true, key_source: "demo", base_url: c.base_url };
    },
    async aiSetConfig(provider, key, model, baseUrl) {
      if (!this.isShim) return this.api.set_ai_config(provider, key, model, baseUrl);
      const c = this._shimAiCfg;
      if (provider) c.provider = provider;
      if (model) c.models[c.provider] = model;
      if (baseUrl != null) c.base_url = baseUrl;
      return this.aiConfig();
    },
    async aiAnalyze(text, question) {
      if (!this.isShim) return this.api.ai_analyze(text, question || null);
      const demo = question
        ? "**Demo answer** (the desktop app calls the real Claude API here).\n\nYour question was: " + question
        : "## Summary\nDemo mode — the desktop app streams a real Claude analysis here.\n\n## Next actions\n- Run `python3 app.py` on your Mac\n- Add your API key under Decide → Claude API Settings";
      let i = 0;
      const tick = () => {
        if (i < demo.length) {
          window.__aiOutput && window.__aiOutput(demo.slice(i, i + 12));
          i += 12;
          setTimeout(tick, 15);
        } else {
          window.__aiDone && window.__aiDone(null);
        }
      };
      setTimeout(tick, 100);
      return { ok: true };
    },

    // Apple Notes — demo data in the browser, osascript on the Mac
    _shimNotes: [
      { id: "demo-1", name: "Groceries", folder: "Notes", content: "Groceries\nmilk\neggs\ncoffee" },
      { id: "demo-2", name: "Ideas", folder: "Notes", content: "Ideas\nbuild a Notepad++ for Mac" },
    ],
    async notesList() {
      if (!this.isShim) return this.api.notes_list();
      return { notes: this._shimNotes.map((n) => ({ id: n.id, name: n.name, folder: n.folder, modified: "" })) };
    },
    async notesGet(id) {
      if (!this.isShim) return this.api.notes_get(id);
      const n = this._shimNotes.find((x) => x.id === id);
      return n ? { name: n.name, content: n.content } : { error: "Note not found" };
    },
    async notesSave(id, content) {
      if (!this.isShim) return this.api.notes_save(id, content);
      const name = (content.split("\n").find((l) => l.trim()) || "Untitled").trim();
      let n = this._shimNotes.find((x) => x.id === id);
      if (!n) { n = { id: "demo-" + (this._shimNotes.length + 1), folder: "Notes" }; this._shimNotes.push(n); }
      n.name = name; n.content = content;
      return { ok: true, id: n.id, name };
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
  let edition = "ai";     // "classic" | "plus" (no AI) | "ai" (everything)
  const isClassic = () => edition === "classic";
  const hasAI = () => edition === "ai";
  // Decide panel: AI edition only. Evolved extras (PDF/Notes): plus and AI.
  const DECIDE_COMMANDS = ["aiAnalyze", "aiAsk", "aiSettings", "toggleInsight"];
  const EVOLVED_COMMANDS = ["openNote", "sendToNotes", "pdfToText"];
  let untitledCounter = 0;
  let cm = null;
  const settings = { wrap: false, lineNumbers: true, fontSize: 13,
                     consoleH: 190, consoleW: 420, consoleDock: "bottom" };

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
      mtime: opts.mtime != null ? opts.mtime : null,
      noteId: opts.noteId || null,
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

  async function closeTab(tab, force = false) {
    if (!force && isDirty(tab) && !(!tab.path && tab.doc.getValue() === "")) {
      const choice = await showConfirm("Save file?",
        'Save changes to "' + tab.name + '" before closing?',
        [{ label: "Save", value: "save" },
         { label: "Don't Save", value: "discard" },
         { label: "Cancel", value: "cancel" }],
        "cancel");
      if (choice === "cancel") return false;
      if (choice === "save" && !(await saveTab(tab))) return false;
    }
    const idx = tabs.indexOf(tab);
    if (idx === -1) return false;
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
    return true;
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
          if (isClassic()) {
            showAlert("Notepad-- AI feature",
              "PDF viewing and annotation live in the Notepad-- AI edition.");
            continue;
          }
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
      if (isClassic()) {
        showAlert("Notepad-- AI feature",
          "PDF viewing and annotation live in the Notepad-- AI edition.\n" +
          "Open this file there, or use another PDF viewer.");
        return;
      }
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
      mtime: res.mtime,
    });
    closeLoneUntitled(tab);
  }

  // Replace a single pristine untitled tab, like Notepad++ does
  function closeLoneUntitled(justOpened) {
    const lone = tabs.find((t) => t !== justOpened && t.type !== "pdf" &&
                                  !t.path && !isDirty(t) && t.doc.getValue() === "");
    if (lone && tabs.length === 2) closeTab(lone, true);
  }

  async function saveTab(tab, saveAs = false) {
    if (tab.type === "pdf") {
      showAlert("Read-only", "PDF tabs are view-only. Use File → Open PDF as Text to get an editable copy of the text.");
      return false;
    }
    if (tab.noteId && !saveAs) {
      // This tab lives in Apple Notes — save back into the same note.
      // Capture the generation BEFORE the async write: keystrokes typed
      // while saving must stay marked dirty.
      const content = tab.doc.getValue("\n");
      const savedGen = tab.doc.changeGeneration();
      const res = await backend.notesSave(tab.noteId, content);
      if (res.error) { showAlert("Apple Notes", res.error); return false; }
      tab.name = res.name || tab.name;
      tab.forceDirty = false;
      tab.cleanGen = savedGen;
      renderTabs();
      updateStatus();
      updateTitle();
      scheduleSessionSave();
      return true;
    }
    let path = tab.path;
    if (!path || saveAs) {
      path = await backend.saveDialog(tab.name.includes(".") ? tab.name : tab.name + ".txt",
                                      tab.path ? tab.path.replace(/\/[^/]*$/, "") : "");
      if (!path) return false;
    }
    const content = tab.doc.getValue(tab.eol);
    const savedGen = tab.doc.changeGeneration();   // typing during the save stays dirty
    // Only guard against disk conflicts when overwriting the file we read
    const guardMtime = !saveAs && path === tab.path ? tab.mtime : null;
    let res = await backend.writeFile(path, content, tab.encoding, guardMtime);
    if (res.conflict) {
      const choice = await showConfirm("File changed on disk",
        '"' + tab.name + '" was modified by another program after you opened it. Overwrite it with your version?',
        [{ label: "Overwrite", value: "overwrite" }, { label: "Cancel", value: "cancel" }],
        "cancel");
      if (choice !== "overwrite") return false;
      res = await backend.writeFile(path, content, tab.encoding, null);
    }
    if (res.error) { showAlert("Save failed", res.error); return false; }
    if (res.encoding) tab.encoding = res.encoding;
    if (res.mtime != null) tab.mtime = res.mtime;
    tab.noteId = null;   // Save As onto disk detaches the tab from Apple Notes
    tab.path = path;
    tab.name = path.split("/").pop();
    tab.lang = langForPath(path);
    if (tab === activeTab) cm.setOption("mode", tab.lang.mime);
    tab.forceDirty = false;
    tab.cleanGen = savedGen;
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

  // Find-bar elements (declared before the PDF module, which shares them)
  const findbar = $("#findbar");
  const findInput = $("#find-input");
  const replaceInput = $("#replace-input");
  const caseCB = $("#find-case");
  const regexCB = $("#find-regex");
  const findCount = $("#find-count");

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
      // isEvalSupported:false blocks CVE-2024-4367-style JS execution from
      // malicious PDFs — critical here since the page holds a file-I/O bridge
      doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
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
    await loadAnnotations(tab);
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
    if (!tab.zoom) {
      tab.zoom = Math.max(0.25, (pdfScroll.clientWidth - 40) / base.width);
      tab.fitWidth = true;
    }
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
    drawAnnotations(tab, n);
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
    if (ph) {
      // offsetTop is body-relative here (no positioned ancestor), so measure
      // the real distance between the page and the scroller instead
      const delta = ph.getBoundingClientRect().top - pdfScroll.getBoundingClientRect().top;
      pdfScroll.scrollTop += delta - 14;
    }
    updatePdfToolbar(tab);
    updateStatus();
    scheduleSessionSave();
  }

  function setPdfZoom(tab, zoom) {
    tab.zoom = zoom ? Math.min(Math.max(zoom, 0.25), 5) : null;
    tab.fitWidth = !zoom;
    const page = tab.page;
    showPdfTab(tab).then(() => { gotoPdfPage(tab, page); });
  }

  function pdfTrackScroll() {
    if (!activeTab || activeTab.type !== "pdf") return;
    const tab = activeTab;
    // Rect math, not offsetTop: pages have no positioned ancestor, so their
    // offsetTop is body-relative and disagrees with the scroller's coordinates
    const midline = pdfScroll.getBoundingClientRect().top + pdfScroll.clientHeight / 2;
    let current = 1;
    for (const ph of pdfPagesEl.children) {
      if (ph.getBoundingClientRect().top <= midline) current = +ph.dataset.page;
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
      dirty: true,   // exists only in memory — show the red dot until saved
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

  // ---- PDF annotations: highlights + note pins, sidecar-persisted --------
  let pdfMode = null;   // null | 'highlight' | 'note'
  let annoSeq = 1;

  function annoKey(tab) {
    return tab.path || ("name:" + tab.name);
  }

  async function loadAnnotations(tab) {
    const res = await backend.annosLoad(annoKey(tab));
    tab.annos = (res && res.data) || { highlights: [], notes: [] };
  }

  function saveAnnotations(tab) {
    backend.annosSave(annoKey(tab), tab.annos);
  }

  function setPdfMode(mode) {
    pdfMode = pdfMode === mode ? null : mode;
    document.getElementById("pdf-mode-highlight").classList.toggle("on", pdfMode === "highlight");
    document.getElementById("pdf-mode-note").classList.toggle("on", pdfMode === "note");
    pdfPagesEl.classList.toggle("mode-note", pdfMode === "note");
  }

  function drawAnnotations(tab, n) {
    const ph = pdfPagesEl.querySelector('.pdf-page[data-page="' + n + '"]');
    if (!ph || !tab.annos) return;
    let layer = ph.querySelector(".anno-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "anno-layer";
      ph.appendChild(layer);
    }
    layer.textContent = "";
    const z = tab.zoom;
    for (const h of tab.annos.highlights) {
      if (h.page !== n) continue;
      for (const r of h.rects) {
        const el = document.createElement("div");
        el.className = "anno-hl";
        el.style.left = r.x * z + "px";
        el.style.top = r.y * z + "px";
        el.style.width = r.w * z + "px";
        el.style.height = r.h * z + "px";
        el.title = "Highlight — click to remove";
        el.addEventListener("click", async (e) => {
          e.stopPropagation();
          const choice = await showConfirm("Remove highlight", "Remove this highlight?",
            [{ label: "Remove", value: "yes" }, { label: "Cancel", value: "no" }], "no");
          if (choice === "yes") {
            tab.annos.highlights = tab.annos.highlights.filter((x) => x.id !== h.id);
            saveAnnotations(tab);
            drawAnnotations(tab, n);
          }
        });
        layer.appendChild(el);
      }
    }
    for (const note of tab.annos.notes) {
      if (note.page !== n) continue;
      const pin = document.createElement("div");
      pin.className = "anno-pin";
      pin.textContent = "✎";
      pin.style.left = note.x * z + "px";
      pin.style.top = note.y * z + "px";
      pin.title = note.text || "Note";
      pin.addEventListener("click", (e) => { e.stopPropagation(); editNote(tab, note, n); });
      layer.appendChild(pin);
    }
  }

  function editNote(tab, note, page) {
    showModal("Note", '<textarea id="note-text" rows="5" style="width:100%;box-sizing:border-box;' +
      'user-select:text;-webkit-user-select:text;font-size:13px;padding:4px;' +
      'border:1px solid #7F9DB9"></textarea>',
      [
        { label: "Save", onClick: () => {
            note.text = document.getElementById("note-text") ? document.getElementById("note-text").value : note.text;
            if (!tab.annos.notes.includes(note)) tab.annos.notes.push(note);
            saveAnnotations(tab);
            drawAnnotations(tab, page);
          } },
        { label: "Delete", onClick: () => {
            tab.annos.notes = tab.annos.notes.filter((x) => x.id !== note.id);
            saveAnnotations(tab);
            drawAnnotations(tab, page);
          } },
        { label: "Cancel" },
      ]);
    const ta = document.getElementById("note-text");
    if (ta) { ta.value = note.text || ""; ta.focus(); }
  }

  function highlightFromSelection(tab) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const startPage = range.startContainer.parentElement
      && range.startContainer.parentElement.closest(".pdf-page");
    if (!startPage) return;
    const n = +startPage.dataset.page;
    const pageRect = startPage.getBoundingClientRect();
    const z = tab.zoom;
    const rects = [];
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      // keep only the parts on the starting page, in scale-1 page coordinates
      if (r.bottom < pageRect.top || r.top > pageRect.bottom) continue;
      rects.push({
        x: (r.left - pageRect.left) / z,
        y: (r.top - pageRect.top) / z,
        w: r.width / z,
        h: r.height / z,
      });
    }
    if (!rects.length) return;
    tab.annos.highlights.push({ id: "h" + Date.now() + "-" + annoSeq++, page: n, rects });
    sel.removeAllRanges();
    saveAnnotations(tab);
    drawAnnotations(tab, n);
  }

  async function exportAnnotatedPdf() {
    const tab = activeTab;
    if (!tab || tab.type !== "pdf") return;
    if (!tab.annos || (!tab.annos.highlights.length && !tab.annos.notes.length)) {
      showAlert("Export Annotated", "No annotations yet — use Highlight or Note first.");
      return;
    }
    setRunStatusSafe("exporting…");
    try {
      const bytes = await tab.doc.getData();               // original PDF bytes
      const pdfDoc = await PDFLib.PDFDocument.load(bytes);
      const pages = pdfDoc.getPages();
      const yellow = PDFLib.rgb(1, 0.86, 0.24);
      const brown = PDFLib.rgb(0.45, 0.29, 0);
      for (const h of tab.annos.highlights) {
        const page = pages[h.page - 1];
        if (!page) continue;
        const H = page.getHeight();
        for (const r of h.rects) {
          page.drawRectangle({ x: r.x, y: H - r.y - r.h, width: r.w, height: r.h,
                               color: yellow, opacity: 0.35 });
        }
      }
      for (const note of tab.annos.notes) {
        const page = pages[note.page - 1];
        if (!page) continue;
        const H = page.getHeight();
        page.drawCircle({ x: note.x, y: H - note.y, size: 7, color: yellow,
                          borderColor: brown, borderWidth: 1 });
        if (note.text) {
          page.drawText(note.text, { x: note.x + 12, y: H - note.y - 3, size: 9,
                                     maxWidth: 220, lineHeight: 11, color: brown });
        }
      }
      const out = await pdfDoc.save();
      window.__lastExportSize = out.length;                // test hook
      let b64 = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < out.length; i += CHUNK) {
        b64 += String.fromCharCode.apply(null, out.subarray(i, i + CHUNK));
      }
      b64 = btoa(b64);
      const suggested = tab.name.replace(/\.pdf$/i, "") + "-annotated.pdf";
      const path = await backend.saveDialog(suggested,
        tab.path ? tab.path.replace(/\/[^/]*$/, "") : "");
      if (!path) return;
      const res = await backend.writeFileB64(path, b64);
      if (res.error) showAlert("Export failed", res.error);
    } catch (e) {
      showAlert("Export failed", e.message || String(e));
    } finally {
      setRunStatusSafe("");
    }
  }

  function setRunStatusSafe(text) {
    const el = document.getElementById("pdf-readonly");
    if (el) el.textContent = text || "read-only";
  }

  function setupPdfToolbar() {
    const tab = () => (activeTab && activeTab.type === "pdf" ? activeTab : null);
    document.getElementById("pdf-prev").addEventListener("click", () => { const t = tab(); if (t) gotoPdfPage(t, t.page - 1); });
    document.getElementById("pdf-next").addEventListener("click", () => { const t = tab(); if (t) gotoPdfPage(t, t.page + 1); });
    document.getElementById("pdf-zoom-in").addEventListener("click", () => { const t = tab(); if (t) setPdfZoom(t, t.zoom * 1.2); });
    document.getElementById("pdf-zoom-out").addEventListener("click", () => { const t = tab(); if (t) setPdfZoom(t, t.zoom / 1.2); });
    document.getElementById("pdf-zoom-fit").addEventListener("click", () => { const t = tab(); if (t) setPdfZoom(t, null); });
    document.getElementById("pdf-extract").addEventListener("click", pdfToText);
    document.getElementById("pdf-mode-highlight").addEventListener("click", () => setPdfMode("highlight"));
    document.getElementById("pdf-mode-note").addEventListener("click", () => setPdfMode("note"));
    document.getElementById("pdf-export").addEventListener("click", exportAnnotatedPdf);
    pdfPagesEl.addEventListener("mouseup", () => {
      const t = tab();
      if (t && pdfMode === "highlight") setTimeout(() => highlightFromSelection(t), 10);
    });
    pdfPagesEl.addEventListener("click", (e) => {
      const t = tab();
      if (!t || pdfMode !== "note") return;
      const ph = e.target.closest(".pdf-page");
      if (!ph) return;
      const rect = ph.getBoundingClientRect();
      const note = {
        id: "n" + Date.now() + "-" + annoSeq++,
        page: +ph.dataset.page,
        x: (e.clientX - rect.left) / t.zoom,
        y: (e.clientY - rect.top) / t.zoom,
        text: "",
      };
      editNote(t, note, note.page);
    });
    document.getElementById("pdf-page-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const t = tab();
      const n = parseInt(e.target.value, 10);
      if (t && !isNaN(n)) gotoPdfPage(t, n);
    });
    pdfScroll.addEventListener("scroll", pdfTrackScroll);
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const t = tab();
        if (t && t.fitWidth) setPdfZoom(t, null);   // re-fit width after resize
      }, 250);
    });
  }

  // ======================================================================
  // Session persistence (Notepad++-style)
  // ======================================================================
  let sessionTimer = null;
  let sessionSaveWarned = false;
  async function persistSession() {
    let res;
    try { res = await backend.saveSession(buildSession()); }
    catch (e) { res = { error: String(e) }; }
    if (res && res.error && res.error !== "not ready" && !sessionSaveWarned) {
      // Warn once: silent failure here means unsaved tabs won't survive a quit
      sessionSaveWarned = true;
      showAlert("Session backup failed",
        "Notepad-- couldn't save your session — unsaved tabs may not survive quitting.\n\n" + res.error);
    } else if (res && res.ok) {
      sessionSaveWarned = false;
    }
  }
  function scheduleSessionSave() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(persistSession, 800);
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
          return { type: "pdf", path: t.path, name: t.name, page: t.page,
                   zoom: t.zoom, fit: !!t.fitWidth };
        }
        const dirty = isDirty(t);
        const cur = t === activeTab ? t.liveCursor : t.cursor;
        const scr = t === activeTab ? t.liveScroll : t.scroll;
        return {
          path: t.path,
          name: t.name,
          noteId: t.noteId || null,
          lang: t.lang.id,
          encoding: t.encoding,
          eol: t.eol,
          mtime: t.mtime != null ? t.mtime : null,   // keeps conflict protection across restarts
          dirty,
          // keep text for anything not safely on disk
          content: dirty || !t.path ? t.doc.getValue() : null,
          cursor: cur ? { line: cur.line, ch: cur.ch } : null,
          scroll: scr ? { left: scr.left, top: scr.top } : null,
        };
      }),
    };
  }

  // Flush the session whenever the window loses foreground or starts closing,
  // so at most a fraction of a second of typing is ever at risk.
  function flushSession() {
    try { persistSession(); } catch (e) { /* mid-boot */ }
  }
  window.addEventListener("beforeunload", flushSession);
  window.addEventListener("pagehide", flushSession);
  window.addEventListener("blur", flushSession);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSession();
  });

  async function restoreSession() {
    const s = await backend.loadSession();
    if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) { newTab(); return; }
    untitledCounter = s.untitledCounter || 0;
    Object.assign(settings, s.settings || {});
    let toActivate = null;
    const missing = [];
    for (let i = 0; i < s.tabs.length; i++) {
      const st = s.tabs[i];
      let tab = null;
      if (st.type === "pdf") {
        if (isClassic()) continue;                 // separate session files make this moot,
        if (!st.path) continue;                    // browser-demo PDFs can't be reopened
        const res = await backend.readFileB64(st.path);
        if (res.error) { missing.push(st.name || st.path); continue; }
        tab = await openPdfBytes(base64ToBytes(res.data), st.path, st.name,
                                 { page: st.page, zoom: st.fit ? null : st.zoom, activate: false });
      } else {
        let content = st.content;
        let mtime = st.mtime != null ? st.mtime : null;
        if (content == null && st.path) {
          const res = await backend.readFile(st.path);
          if (res.error) { missing.push(st.name || st.path); continue; }
          content = res.content.replace(/\r\n/g, "\n");
          mtime = res.mtime;
        }
        tab = newTab({
          path: st.path,
          name: st.name,
          noteId: st.noteId || null,
          content: content || "",
          lang: langById(st.lang),
          encoding: st.encoding,
          eol: st.eol || "\n",
          mtime,
          dirty: !!st.dirty,
          cursor: st.cursor,
          scroll: st.scroll,
          activate: false,
        });
      }
      if (i === (s.activeIndex || 0) && tab) toActivate = tab;
    }
    if (tabs.length === 0) newTab();
    else activateTab(toActivate || tabs[tabs.length - 1]);
    if (missing.length) {
      showAlert("Some tabs couldn't be reopened",
        "These files from your last session are missing or unreadable:\n\n" +
        missing.join("\n"));
    }
  }

  // ======================================================================
  // Find / Replace
  // ======================================================================
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
    findCount.textContent = n === 0 ? "no matches"
      : n >= 10000 ? "10000+ matches"
      : n + (n === 1 ? " match" : " matches");
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
  // Cache the document length — getValue() joins the whole file, far too
  // costly to redo on every keystroke or cursor move in large files
  let lenCache = { doc: null, gen: -1, len: 0 };
  function docLength(doc) {
    const gen = doc.changeGeneration();
    if (lenCache.doc === doc && lenCache.gen === gen) return lenCache.len;
    lenCache = { doc, gen, len: doc.getValue().length };
    return lenCache.len;
  }

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
    // like Notepad++, count line endings at their on-disk width (CRLF = 2)
    const eolExtra = activeTab.eol === "\r\n" ? doc.lineCount() - 1 : 0;
    $("#st-lang").textContent = activeTab.lang.name;
    $("#st-length").textContent = `length : ${docLength(doc) + eolExtra}    lines : ${doc.lineCount()}`;
    $("#st-pos").textContent = `Ln : ${pos.line + 1}    Col : ${pos.ch + 1}    Sel : ${selChars} | ${selLines}`;
    $("#st-eol").textContent = activeTab.eol === "\r\n" ? "Windows (CR LF)" : "Unix (LF)";
    $("#st-enc").textContent = activeTab.encoding;
  }

  // ======================================================================
  // Apple Notes
  // ======================================================================
  async function openNoteTab(id) {
    const existing = tabs.find((t) => t.noteId === id);
    if (existing) { activateTab(existing); return; }
    const res = await backend.notesGet(id);
    if (res.error) { showAlert("Apple Notes", res.error); return; }
    const tab = newTab({
      name: res.name || "Note",
      content: res.content || "",
      lang: langById("text"),
      encoding: "Apple Note",
      noteId: id,
    });
    closeLoneUntitled(tab);
    scheduleSessionSave();
  }

  async function openNotePicker() {
    showModal("Open Apple Note",
      '<input id="note-filter" type="text" placeholder="Type to filter notes…">' +
      '<div id="note-list"><div class="note-empty">Loading notes…</div></div>',
      [{ label: "Cancel" }]);
    const listEl = $("#note-list");
    const filterEl = $("#note-filter");
    const res = await backend.notesList();
    if (res.error) {
      listEl.innerHTML = '<div class="note-empty">' + escapeHtml(res.error) + "</div>";
      return;
    }
    const notes = res.notes || [];
    const render = (filter) => {
      const q = (filter || "").toLowerCase();
      const shown = notes.filter((n) => !q || (n.name + " " + n.folder).toLowerCase().includes(q));
      listEl.textContent = "";
      if (!shown.length) {
        listEl.innerHTML = '<div class="note-empty">No matching notes</div>';
        return;
      }
      for (const n of shown.slice(0, 200)) {
        const row = document.createElement("div");
        row.className = "note-row";
        const name = document.createElement("span");
        name.textContent = n.name;
        const folder = document.createElement("span");
        folder.className = "note-folder";
        folder.textContent = n.folder;
        row.append(name, folder);
        row.addEventListener("click", () => { hideModal(); openNoteTab(n.id); });
        listEl.appendChild(row);
      }
    };
    render("");
    filterEl.addEventListener("input", () => render(filterEl.value));
    filterEl.focus();
  }

  async function sendToNotes() {
    const tab = activeTab;
    if (!tab || tab.type === "pdf") {
      showAlert("Apple Notes", "Switch to a text tab to send it to Apple Notes.");
      return;
    }
    if (tab.noteId) { saveTab(tab); return; }   // already a note — just save it
    const res = await backend.notesSave(null, tab.doc.getValue("\n"));
    if (res.error) { showAlert("Apple Notes", res.error); return; }
    showAlert("Apple Notes", 'Saved to Apple Notes as "' + (res.name || "Untitled") + '".');
  }

  // ======================================================================
  // Run console
  // ======================================================================
  const consoleEl = document.getElementById("console");
  const consoleOut = document.getElementById("console-out");
  const consoleStatus = document.getElementById("console-status");
  const consoleCmd = document.getElementById("console-cmd");
  const cmdHistory = [];
  let cmdHistoryIdx = -1;

  function applyConsoleLayout() {
    const right = settings.consoleDock === "right";
    consoleEl.classList.toggle("dock-right", right);
    if (right) {
      consoleEl.style.height = "";
      consoleEl.style.width = Math.max(240, settings.consoleW) + "px";
      // right dock: console sits beside the editor column
      document.getElementById("main-row").insertBefore(
        consoleEl, document.getElementById("insight"));
    } else {
      consoleEl.style.width = "";
      consoleEl.style.height = Math.max(90, settings.consoleH) + "px";
      document.getElementById("main-col").appendChild(consoleEl);
    }
  }

  function showConsole(show) {
    consoleEl.classList.toggle("hidden", !show);
    if (show) applyConsoleLayout();
    cm.refresh();
  }

  function setRunStatus(text, cls) {
    consoleStatus.textContent = text;
    consoleStatus.className = cls || "";
  }

  function appendConsole(text, cls) {
    const nearBottom = consoleOut.scrollHeight - consoleOut.scrollTop - consoleOut.clientHeight < 40;
    const span = document.createElement("span");
    span.className = "con-" + (cls || "out");
    span.textContent = text;
    consoleOut.appendChild(span);
    while (consoleOut.childNodes.length > 5000) consoleOut.removeChild(consoleOut.firstChild);
    if (nearBottom) consoleOut.scrollTop = consoleOut.scrollHeight;
  }

  window.__runOutput = (text, stream) => appendConsole(text, stream);
  window.__runDone = (code) => {
    setRunStatus(code === 0 ? "finished (exit 0)" : "failed (exit " + code + ")",
                 code === 0 ? "ok" : "fail");
  };

  async function startRun(promise) {
    showConsole(true);
    setRunStatus("running…", "run");
    const res = await promise;
    if (res && res.error) {
      appendConsole(res.error, "err");
      setRunStatus("failed", "fail");
    }
  }

  async function runActiveFile() {
    const tab = activeTab;
    if (!tab || tab.type === "pdf") {
      showAlert("Run", "Switch to a text tab to run it.");
      return;
    }
    if (!tab.path || isDirty(tab)) {
      if (!(await saveTab(tab))) return;   // must be on disk to run
    }
    await startRun(backend.runFile(tab.path, tab.lang.id));
  }

  function runShellCommandUI() {
    showConsole(true);
    consoleCmd.focus();
  }

  function setupConsole() {
    consoleCmd.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!cmdHistory.length) return;
        e.preventDefault();
        cmdHistoryIdx = e.key === "ArrowUp"
          ? Math.max(0, cmdHistoryIdx === -1 ? cmdHistory.length - 1 : cmdHistoryIdx - 1)
          : Math.min(cmdHistory.length - 1, cmdHistoryIdx + 1);
        consoleCmd.value = cmdHistory[cmdHistoryIdx];
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const cmd = consoleCmd.value.trim();
      if (!cmd) return;
      cmdHistory.push(cmd);
      if (cmdHistory.length > 50) cmdHistory.shift();
      cmdHistoryIdx = -1;
      consoleCmd.value = "";
      const cwd = activeTab && activeTab.path
        ? activeTab.path.replace(/\/[^/]*$/, "") : null;
      startRun(backend.runCommand(cmd, cwd));
    });
    document.getElementById("console-stop").addEventListener("click", () => backend.runStop());
    document.getElementById("console-clear").addEventListener("click", () => { consoleOut.textContent = ""; });
    document.getElementById("console-close").addEventListener("click", () => showConsole(false));
    document.getElementById("console-dock").addEventListener("click", () => {
      settings.consoleDock = settings.consoleDock === "right" ? "bottom" : "right";
      applyConsoleLayout();
      cm.refresh();
      scheduleSessionSave();
    });

    // Drag the console edge to resize (top edge when docked bottom, left when right)
    const resizer = document.getElementById("console-resizer");
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startH = consoleEl.offsetHeight, startW = consoleEl.offsetWidth;
      const move = (ev) => {
        if (settings.consoleDock === "right") {
          settings.consoleW = Math.min(Math.max(startW + (startX - ev.clientX), 240),
                                       window.innerWidth - 300);
          consoleEl.style.width = settings.consoleW + "px";
        } else {
          settings.consoleH = Math.min(Math.max(startH + (startY - ev.clientY), 90),
                                       window.innerHeight - 200);
          consoleEl.style.height = settings.consoleH + "px";
        }
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        cm.refresh();
        scheduleSessionSave();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // ======================================================================
  // Decide panel — decision intelligence via the Claude API
  // ======================================================================
  const insightEl = document.getElementById("insight");
  const insightOut = document.getElementById("insight-out");
  const insightStatus = document.getElementById("insight-status");
  const insightQ = document.getElementById("insight-q");
  let aiBuffer = "";
  let aiRunning = false;

  function showInsight(show) {
    insightEl.classList.toggle("hidden", !show);
    cm.refresh();
  }

  function setAiStatus(text, cls) {
    insightStatus.textContent = text;
    insightStatus.className = cls || "";
  }

  // Minimal markdown: headings, bold, bullets — enough for a decision brief
  function renderMarkdown(md) {
    const out = [];
    let inList = false;
    for (const rawLine of md.split("\n")) {
      const line = escapeHtml(rawLine)
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + bullet[1] + "</li>");
        continue;
      }
      if (inList) { out.push("</ul>"); inList = false; }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        const level = Math.max(2, h[1].length);   // '#'/'##' → h2, '###' → h3
        out.push("<h" + level + ">" + h[2] + "</h" + level + ">");
      } else if (line.trim()) out.push("<p>" + line + "</p>");
    }
    if (inList) out.push("</ul>");
    return out.join("");
  }

  window.__aiOutput = (chunk) => {
    aiBuffer += chunk;
    // stream as plain text; render markdown once complete
    let pre = insightOut.querySelector("pre");
    if (!pre) {
      insightOut.textContent = "";
      pre = document.createElement("pre");
      insightOut.appendChild(pre);
    }
    pre.textContent = aiBuffer;
    insightOut.scrollTop = insightOut.scrollHeight;
  };

  window.__aiDone = (error) => {
    aiRunning = false;
    if (error) {
      setAiStatus("failed", "fail");
      insightOut.innerHTML = '<div class="insight-empty">' + escapeHtml(error) + "</div>";
      return;
    }
    setAiStatus("done", "");
    insightOut.innerHTML = renderMarkdown(aiBuffer);
  };

  async function activeDocumentText() {
    const tab = activeTab;
    if (!tab) return null;
    if (tab.type === "pdf") {
      const texts = await ensurePdfTexts(tab);
      return texts.map((p) => p.text.trimEnd()).join("\n\n");
    }
    return tab.doc.getValue();
  }

  async function runAnalysis(question) {
    if (aiRunning) { setAiStatus("already running…", "run"); return; }
    const text = await activeDocumentText();
    if (!text || !text.trim()) {
      showAlert("Decide", "The current tab is empty — open or write a document first.");
      return;
    }
    const MAX_CHARS = 600000;   // keep well inside the context window
    const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
    showInsight(true);
    aiBuffer = "";
    aiRunning = true;
    insightOut.innerHTML = "";
    setAiStatus("thinking…", "run");
    const res = await backend.aiAnalyze(clipped, question || null);
    if (res && res.error) {
      aiRunning = false;
      setAiStatus("failed", "fail");
      insightOut.innerHTML = '<div class="insight-empty">' + escapeHtml(res.error) + "</div>";
    } else if (text.length > MAX_CHARS) {
      appendConsoleNote();
    }
  }

  function appendConsoleNote() {
    setAiStatus("analyzing (document truncated — it was very large)", "run");
  }

  async function aiSettingsDialog() {
    const cfg = await backend.aiConfig();
    const current = cfg.has_key
      ? "Key: " + escapeHtml(cfg.key_source || "settings") + "."
      : "No key configured yet.";
    showModal("AI Provider Settings",
      "<div>" + current + "</div>" +
      '<label style="display:block;margin-top:10px">Provider:</label>' +
      '<select id="ai-provider" style="width:100%;padding:4px;border:1px solid #7F9DB9">' +
      '<option value="anthropic">Claude (Anthropic)</option>' +
      '<option value="openai">OpenAI</option>' +
      '<option value="custom">OpenAI-compatible (Ollama, OpenRouter, Groq…)</option>' +
      "</select>" +
      '<label style="display:block;margin-top:8px">API key' +
      " (blank = keep current; optional for local servers):</label>" +
      '<input id="ai-key" type="password">' +
      '<label style="display:block;margin-top:8px">Model:</label>' +
      '<input id="ai-model" type="text">' +
      '<div id="ai-baseurl-row"><label style="display:block;margin-top:8px">Base URL' +
      " (OpenAI-compatible servers only):</label>" +
      '<input id="ai-baseurl" type="text" placeholder="http://localhost:11434/v1"></div>',
      [{ label: "Save", onClick: async () => {
          const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
          const res = await backend.aiSetConfig(
            get("ai-provider"), get("ai-key"), get("ai-model"), get("ai-baseurl"));
          if (res.error) showAlert("Settings", res.error);
        } },
       { label: "Cancel" }]);
    const providerSel = document.getElementById("ai-provider");
    const modelInput = document.getElementById("ai-model");
    const baseRow = document.getElementById("ai-baseurl-row");
    const baseInput = document.getElementById("ai-baseurl");
    if (!providerSel) return;
    providerSel.value = cfg.provider || "anthropic";
    modelInput.value = cfg.model || "";
    baseInput.value = cfg.base_url || "";
    const sync = () => {
      modelInput.value = (cfg.models && cfg.models[providerSel.value]) || "";
      baseRow.style.display = providerSel.value === "custom" ? "" : "none";
    };
    providerSel.addEventListener("change", sync);
    baseRow.style.display = providerSel.value === "custom" ? "" : "none";
  }

  function setupInsight() {
    document.getElementById("insight-close").addEventListener("click", () => showInsight(false));
    document.getElementById("insight-settings").addEventListener("click", aiSettingsDialog);
    document.getElementById("insight-analyze").addEventListener("click", () => runAnalysis(null));
    insightQ.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = insightQ.value.trim();
      if (!q) return;
      insightQ.value = "";
      runAnalysis(q);
    });
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
  let modalOnDismiss = null;   // fires when the modal closes without a button press
  function showModal(title, bodyHTML, buttons) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHTML;
    const bb = $("#modal-buttons");
    bb.textContent = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.addEventListener("click", () => { modalOnDismiss = null; hideModal(); b.onClick && b.onClick(); });
      bb.appendChild(btn);
    }
    backdrop.classList.remove("hidden");
    const inp = $("#modal-body input");
    if (inp) { inp.focus(); inp.select(); }
  }
  function hideModal() {
    backdrop.classList.add("hidden");
    if (modalOnDismiss) { const f = modalOnDismiss; modalOnDismiss = null; f(); }
    if (!activeTab || activeTab.type !== "pdf") cm.focus();
  }

  // Ask the user to pick a button; Esc / click-away resolves to dismissValue.
  function showConfirm(title, msg, buttons, dismissValue) {
    return new Promise((resolve) => {
      modalOnDismiss = () => resolve(dismissValue);
      showModal(title, "<div>" + escapeHtml(msg) + "</div>",
        buttons.map((b) => ({ label: b.label, onClick: () => resolve(b.value) })));
    });
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
    if (!hasAI() && DECIDE_COMMANDS.includes(cmd)) return;
    if (isClassic() && EVOLVED_COMMANDS.includes(cmd)) return;
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
      closeAll: async () => {
        for (const t of [...tabs]) {
          if (!(await closeTab(t))) break;   // Cancel stops the sweep
        }
      },
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
      openNote: openNotePicker,
      sendToNotes,
      runFile: runActiveFile,
      runShellCommand: runShellCommandUI,
      runStop: () => backend.runStop(),
      toggleConsole: () => showConsole(consoleEl.classList.contains("hidden")),
      aiAnalyze: () => runAnalysis(null),
      aiAsk: () => { showInsight(true); insightQ.focus(); },
      aiSettings: aiSettingsDialog,
      toggleInsight: () => showInsight(insightEl.classList.contains("hidden")),
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
      else if (k === "r") cmd = e.shiftKey ? "runShellCommand" : "runFile";
      else if (k === "a" && e.shiftKey) cmd = "aiAnalyze";
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
    setupConsole();
    setupInsight();
    await backend.init();
    edition = await backend.getEdition();
    if (isClassic()) document.body.classList.add("classic");
    if (!hasAI()) document.body.classList.add("no-ai");
    await restoreSession();
    // Files the app was launched with (Finder "Open With", CLI args)
    for (const p of await backend.startupFiles()) await openPath(p);
    cm.setOption("lineWrapping", settings.wrap);
    cm.setOption("lineNumbers", settings.lineNumbers);
    applyFontSize();
    syncMenuChecks();
    updateStatus();
    cm.focus();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
