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
            out.push({ shimName: f.name, shimContent: await f.text() });
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
    return tab.cleanGen === -1 || !tab.doc.isClean(tab.cleanGen);
  }

  function activateTab(tab) {
    if (activeTab === tab) return;
    if (activeTab) {
      activeTab.scroll = cm.getScrollInfo();
      activeTab.cursor = cm.getCursor();
    }
    activeTab = tab;
    cm.swapDoc(tab.doc);
    cm.setOption("mode", tab.lang.mime);
    if (tab.cursor) { cm.setCursor(tab.cursor); tab.cursor = null; }
    if (tab.scroll) { cm.scrollTo(tab.scroll.left, tab.scroll.top); tab.scroll = null; }
    renderTabs();
    updateStatus();
    updateTitle();
    scheduleOverlayUpdate();
    cm.focus();
    scheduleSessionSave();
  }

  function closeTab(tab) {
    const idx = tabs.indexOf(tab);
    if (idx === -1) return;
    tabs.splice(idx, 1);
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
        newTab({ name: pick.shimName, content: pick.shimContent,
                 lang: langForPath(pick.shimName), eol: detectEol(pick.shimContent) });
        continue;
      }
      await openPath(pick);
    }
  }

  async function openPath(path) {
    const existing = tabs.find((t) => t.path === path);
    if (existing) { activateTab(existing); return; }
    const res = await backend.readFile(path);
    if (res.error) { showAlert("Open failed", res.error); return; }
    const tab = newTab({
      path,
      content: res.content.replace(/\r\n/g, "\n"),
      encoding: res.encoding,
      eol: detectEol(res.content),
    });
    // Replace a single pristine untitled tab, like Notepad++ does
    const lone = tabs.find((t) => t !== tab && !t.path && !isDirty(t) && t.doc.getValue() === "");
    if (lone && tabs.length === 2) closeTab(lone);
  }

  async function saveTab(tab, saveAs = false) {
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
      if (isDirty(tab) || !tab.path) await saveTab(tab);
    }
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
    $("#replacerow").classList.toggle("hidden", !withReplace);
    const sel = cm.getSelection();
    if (sel && !sel.includes("\n")) findInput.value = sel;
    findInput.focus();
    findInput.select();
    updateOverlay();
  }

  function hideFindbar() {
    findbar.classList.add("hidden");
    updateOverlay();
    cm.focus();
  }

  // ======================================================================
  // Status bar
  // ======================================================================
  function updateStatus() {
    if (!activeTab) return;
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
    if (!activeTab) return;
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
  function hideModal() { backdrop.classList.add("hidden"); cm.focus(); }
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) hideModal(); });

  function showAlert(title, msg) {
    showModal(title, "<div>" + escapeHtml(msg) + "</div>", [{ label: "OK" }]);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
      about: aboutDialog,
    };
    const fn = actions[cmd];
    if (fn) fn();
    if (!["find", "replace", "gotoLine", "about"].includes(cmd)) cm.focus();
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
