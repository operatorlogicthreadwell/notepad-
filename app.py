"""Notepad-- : a Notepad++-style editor for macOS.

HTML/JS user interface wrapped in a native window with Python (pywebview).
On macOS the UI renders in the system WKWebView, so the app stays tiny.

Run:            python3 app.py            (add --debug for web inspector)
Build .app:     ./build_app.sh
"""

import base64
import json
import os
import subprocess
import sys
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
    CODECS = {"UTF-8": "utf-8", "UTF-8-BOM": "utf-8-sig", "ANSI": "latin-1"}

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
        try:
            with open(path, "wb") as f:
                f.write(data)
            return {"ok": True, "encoding": encoding, "mtime": os.path.getmtime(path)}
        except OSError as exc:
            return {"error": str(exc)}

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
            proc.terminate()
            try:
                proc.wait(2)
            except subprocess.TimeoutExpired:
                proc.kill()
            return {"ok": True}
        return {"ok": False}

    def _spawn(self, cmd, shell, cwd):
        if self._proc and self._proc.poll() is None:
            return {"error": "A process is already running — stop it first.\n"}
        env = os.environ.copy()
        # GUI apps on macOS get a minimal PATH; add the usual tool locations
        env["PATH"] = ":".join([env.get("PATH", "/usr/bin:/bin"),
                                "/usr/local/bin", "/opt/homebrew/bin"])
        try:
            self._proc = subprocess.Popen(
                cmd, shell=shell, cwd=cwd or None, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL, text=True, errors="replace", bufsize=1)
        except OSError as exc:
            return {"error": str(exc) + "\n"}
        proc = self._proc

        def pump(pipe, name):
            for line in iter(pipe.readline, ""):
                self._emit_output(name, line)
            pipe.close()

        pumps = [threading.Thread(target=pump, args=(proc.stdout, "out"), daemon=True),
                 threading.Thread(target=pump, args=(proc.stderr, "err"), daemon=True)]
        for t in pumps:
            t.start()

        def wait():
            code = proc.wait()
            for t in pumps:          # let the last output lines land first
                t.join(timeout=3)
            self._emit_js("window.__runDone && window.__runDone(%d)" % code)

        threading.Thread(target=wait, daemon=True).start()
        return {"ok": True}

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
