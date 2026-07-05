"""Notepad-- : a Notepad++-style editor for macOS.

HTML/JS user interface wrapped in a native window with Python (pywebview).
On macOS the UI renders in the system WKWebView, so the app stays tiny.

Run:            python3 app.py            (add --debug for web inspector)
Build .app:     ./build_app.sh
"""

import base64
import html as htmllib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading

import webview

APP_NAME = "Notepad--"


def ui_file():
    """Path to ui/index.html, both in dev and inside a PyInstaller bundle."""
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "ui", "index.html")


def data_dir():
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif os.name == "nt":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    else:
        base = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    path = os.path.join(base, APP_NAME)
    os.makedirs(path, exist_ok=True)
    return path


SESSION_FILE = os.path.join(data_dir(), "session.json")


# Files handed to us at launch (Finder "Open With" via argv-emulation, or CLI)
STARTUP_FILES = [a for a in sys.argv[1:] if not a.startswith("-") and os.path.isfile(a)]


class Api:
    """Methods callable from JavaScript via window.pywebview.api.*"""

    def __init__(self):
        self.window = None
        self._proc = None
        self._proc_lock = threading.Lock()

    def get_startup_files(self):
        return STARTUP_FILES

    # ---- dialogs -------------------------------------------------------
    def open_dialog(self):
        paths = self.window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True)
        return [str(p) for p in paths] if paths else []

    def save_dialog(self, suggested_name="new 1.txt", directory=""):
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=suggested_name, directory=directory or ""
        )
        if isinstance(result, (list, tuple)):
            result = result[0] if result else None
        return str(result) if result else None

    # ---- file I/O ------------------------------------------------------
    MAX_TEXT_BYTES = 64 * 1024 * 1024
    MAX_PDF_BYTES = 256 * 1024 * 1024
    CODECS = {"UTF-8": "utf-8", "UTF-8-BOM": "utf-8-sig", "ANSI": "latin-1",
              "UTF-16": "utf-16"}

    def _size_guard(self, path, limit):
        try:
            size = os.path.getsize(path)
        except OSError as exc:
            return str(exc)
        if size > limit:
            return "File is %d MB; Notepad-- opens files up to %d MB." % (
                size // (1024 * 1024), limit // (1024 * 1024))
        return None

    def read_file(self, path):
        err = self._size_guard(path, self.MAX_TEXT_BYTES)
        if err:
            return {"error": err}
        try:
            with open(path, "rb") as f:
                raw = f.read()
            mtime = os.path.getmtime(path)
        except OSError as exc:
            return {"error": str(exc)}
        if raw.startswith(b"\xef\xbb\xbf"):
            text = raw.decode("utf-8-sig")
            encoding = "UTF-8-BOM"
        elif raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
            text = raw.decode("utf-16")   # BOM selects the byte order
            encoding = "UTF-16"
        else:
            try:
                text = raw.decode("utf-8")
                encoding = "UTF-8"
            except UnicodeDecodeError:
                text = raw.decode("latin-1")
                encoding = "ANSI"
        return {"content": text, "encoding": encoding, "mtime": mtime}

    def read_file_b64(self, path):
        """Binary read for non-text documents (PDFs), base64-encoded."""
        err = self._size_guard(path, self.MAX_PDF_BYTES)
        if err:
            return {"error": err}
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as exc:
            return {"error": str(exc)}
        return {"data": base64.b64encode(raw).decode("ascii")}

    def write_file(self, path, content, encoding="UTF-8", expected_mtime=None):
        # Refuse to clobber changes another program made since we read the file
        if expected_mtime is not None:
            try:
                if abs(os.path.getmtime(path) - expected_mtime) > 1e-6:
                    return {"conflict": True}
            except OSError:
                pass  # file was deleted/moved; plain save recreates it
        codec = self.CODECS.get(encoding, "utf-8")
        try:
            data = content.encode(codec)
        except UnicodeEncodeError:
            # e.g. an emoji typed into an ANSI file — fall back rather than fail
            data = content.encode("utf-8")
            encoding = "UTF-8"
        # Atomic save: write a sibling temp file, then rename over the target,
        # so a crash or full disk mid-write can never destroy the original.
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(
                dir=os.path.dirname(path) or ".", prefix=".notepad-save-")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            try:
                os.chmod(tmp, os.stat(path).st_mode)   # keep original permissions
            except OSError:
                pass                                    # new file: default perms
            os.replace(tmp, path)
            tmp = None
            return {"ok": True, "encoding": encoding, "mtime": os.path.getmtime(path)}
        except OSError as exc:
            return {"error": str(exc)}
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    # ---- session (Notepad++-style "never lose a note") ------------------
    def load_session(self):
        try:
            with open(SESSION_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save_session(self, session):
        return self._write_session(session)

    def _write_session(self, session):
        try:
            tmp = SESSION_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(session, f)
            os.replace(tmp, SESSION_FILE)
            return {"ok": True}
        except OSError as exc:
            return {"error": str(exc)}

    # ---- running scripts (Notepad++ "Run" menu) --------------------------
    def _emit_js(self, script):
        try:
            self.window.evaluate_js(script)
        except Exception:
            pass

    def _emit_output(self, stream, text):
        self._emit_js("window.__runOutput && window.__runOutput(%s, %s)"
                      % (json.dumps(text), json.dumps(stream)))

    def run_file(self, path, lang):
        ext = os.path.splitext(path)[1].lower()
        if lang == "python" or ext in (".py", ".pyw"):
            argv = ["python3", path]
        elif lang == "shell" or ext in (".sh", ".bash", ".zsh", ".command"):
            argv = ["bash", path]
        else:
            return {"error": "Don't know how to run %s files — use Run Shell Command instead."
                             % (ext or "these")}
        self._emit_output("cmd", "$ %s\n" % " ".join(argv))
        return self._spawn(argv, shell=False, cwd=os.path.dirname(path))

    def run_command(self, cmd, cwd=None):
        self._emit_output("cmd", "$ %s\n" % cmd)
        return self._spawn(cmd, shell=True, cwd=cwd)

    def run_stop(self):
        proc = self._proc
        if proc and proc.poll() is None:
            # Kill the whole process group — a bare terminate() only reaches
            # the wrapping shell, leaving grandchildren (servers etc.) alive
            def signal_group(sig):
                try:
                    os.killpg(os.getpgid(proc.pid), sig)
                except (OSError, ProcessLookupError):
                    proc.terminate() if sig == signal.SIGTERM else proc.kill()
            signal_group(signal.SIGTERM)
            try:
                proc.wait(2)
            except subprocess.TimeoutExpired:
                signal_group(signal.SIGKILL)
            return {"ok": True}
        return {"ok": False}

    def _spawn(self, cmd, shell, cwd):
        env = os.environ.copy()
        # GUI apps on macOS get a minimal PATH; add the usual tool locations
        env["PATH"] = ":".join([env.get("PATH", "/usr/bin:/bin"),
                                "/usr/local/bin", "/opt/homebrew/bin"])
        with self._proc_lock:
            if self._proc and self._proc.poll() is None:
                return {"error": "A process is already running — stop it first.\n"}
            try:
                self._proc = subprocess.Popen(
                    cmd, shell=shell, cwd=cwd or None, env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL, text=True, errors="replace",
                    bufsize=1, start_new_session=True)
            except OSError as exc:
                return {"error": str(exc) + "\n"}
            proc = self._proc

        # Batch output lines and flush every 50ms: streaming line-by-line
        # through evaluate_js can flood the macOS main thread
        buf = {"out": [], "err": []}
        buf_lock = threading.Lock()

        def flush():
            with buf_lock:
                chunks = [(name, "".join(lines)) for name, lines in buf.items() if lines]
                for name in buf:
                    buf[name] = []
            for name, text in chunks:
                self._emit_output(name, text)

        def pump(pipe, name):
            for line in iter(pipe.readline, ""):
                with buf_lock:
                    buf[name].append(line)
            pipe.close()

        def flusher():
            tick = threading.Event()
            while proc.poll() is None:
                flush()
                tick.wait(0.05)

        threading.Thread(target=flusher, daemon=True).start()

        pumps = [threading.Thread(target=pump, args=(proc.stdout, "out"), daemon=True),
                 threading.Thread(target=pump, args=(proc.stderr, "err"), daemon=True)]
        for t in pumps:
            t.start()

        def wait():
            code = proc.wait()
            for t in pumps:          # let the last output lines land first
                t.join(timeout=3)
            flush()
            self._emit_js("window.__runDone && window.__runDone(%d)" % code)

        threading.Thread(target=wait, daemon=True).start()
        return {"ok": True}

    # ---- Apple Notes (via macOS automation / osascript JXA) --------------
    _NOTES_LIST_JXA = """
var app = Application('Notes');
var ids = app.notes.id();
var names = app.notes.name();
var mods = [];
try { mods = app.notes.modificationDate(); } catch (e) {}
var folders = [];
try { folders = app.notes.container.name(); } catch (e) {}
var out = [];
for (var i = 0; i < ids.length; i++) {
  out.push({ id: ids[i], name: names[i] || 'Untitled',
             folder: folders[i] || '',
             modified: mods[i] ? mods[i].toISOString() : '' });
}
out.sort(function (a, b) { return a.modified < b.modified ? 1 : -1; });
JSON.stringify(out.slice(0, 500));
"""

    def _osascript(self, script, timeout=90):
        if sys.platform != "darwin":
            return {"error": "Apple Notes integration works on macOS only."}
        try:
            proc = subprocess.run(
                ["osascript", "-l", "JavaScript", "-e", script],
                capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"error": str(exc)}
        if proc.returncode != 0:
            err = proc.stderr.strip()
            if "-1743" in err:
                return {"error": "Notepad-- isn't allowed to control Notes.\n"
                                 "Allow it under System Settings → Privacy & Security "
                                 "→ Automation → Notepad-- → Notes, then try again."}
            return {"error": err or "Could not talk to Apple Notes."}
        try:
            return {"data": json.loads(proc.stdout.strip())}
        except ValueError:
            return {"error": "Unexpected reply from Notes: " + proc.stdout[:200]}

    @staticmethod
    def _html_to_text(body):
        """Apple Notes bodies are HTML; flatten to editable plain text."""
        # An empty paragraph is <div><br></div>; drop the <br> so it becomes
        # exactly one newline and blank-line structure round-trips unchanged
        s = re.sub(r"<br[^>]*>\s*</div>", "</div>", body, flags=re.I)
        # A heading/list closing right before its wrapping div would emit two
        # newlines for one visual line break — drop the inner close
        s = re.sub(r"</(?:h1|h2|h3|ul|ol)>\s*(?=</div>)", "", s, flags=re.I)
        s = re.sub(r"<br[^>]*>", "\n", s, flags=re.I)
        s = re.sub(r"<li[^>]*>", "- ", s, flags=re.I)
        s = re.sub(r"</(?:li|div|h1|h2|h3|ul|ol)>\s*", "\n", s, flags=re.I)
        s = re.sub(r"<[^>]+>", "", s)
        s = htmllib.unescape(s)
        return s.rstrip("\n")

    @staticmethod
    def _text_to_html(text):
        lines = text.split("\n")
        return "".join(
            "<div>%s</div>" % (htmllib.escape(line) if line.strip() else "<br>")
            for line in lines)

    def notes_list(self):
        result = self._osascript(self._NOTES_LIST_JXA)
        if "error" in result:
            return result
        return {"notes": result["data"]}

    def notes_get(self, note_id):
        script = ("var p = %s;\n"
                  "var app = Application('Notes');\n"
                  "var n = app.notes.byId(p.id);\n"
                  "JSON.stringify({ name: n.name(), body: n.body() });"
                  % json.dumps({"id": note_id}))
        result = self._osascript(script)
        if "error" in result:
            return result
        data = result["data"]
        return {"name": data.get("name") or "Untitled",
                "content": self._html_to_text(data.get("body") or "")}

    def notes_save(self, note_id, content):
        payload = {"id": note_id, "body": self._text_to_html(content)}
        script = ("var p = %s;\n"
                  "var app = Application('Notes');\n"
                  "var out;\n"
                  "if (p.id) {\n"
                  "  var n = app.notes.byId(p.id);\n"
                  "  n.body = p.body;\n"
                  "  out = { ok: true, id: p.id, name: n.name() };\n"
                  "} else {\n"
                  "  var n = app.make({ new: 'note', withProperties: { body: p.body } });\n"
                  "  out = { ok: true, id: n.id(), name: n.name() };\n"
                  "}\n"
                  "JSON.stringify(out);" % json.dumps(payload))
        result = self._osascript(script)
        if "error" in result:
            return result
        return result["data"]

    # ---- window --------------------------------------------------------
    def set_title(self, title):
        try:
            self.window.set_title(title)
        except Exception:
            pass
        return True


def main():
    api = Api()
    window = webview.create_window(
        APP_NAME,
        ui_file(),
        js_api=api,
        width=1100,
        height=750,
        min_size=(640, 420),
        text_select=True,
    )
    api.window = window

    # NOTE: do not call window.evaluate_js from the `closing` event — on macOS
    # it deadlocks the main thread and the app hangs on quit. The UI persists
    # the session continuously (debounced saves plus pagehide/visibility
    # flushes), so there is nothing to do here at close time.
    webview.start(debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
