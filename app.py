"""Notepad-- : a Notepad++-style editor for macOS.

HTML/JS user interface wrapped in a native window with Python (pywebview).
On macOS the UI renders in the system WKWebView, so the app stays tiny.

Run:            python3 app.py            (add --debug for web inspector)
Build .app:     ./build_app.sh
"""

import base64
import json
import os
import sys

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


class Api:
    """Methods callable from JavaScript via window.pywebview.api.*"""

    def __init__(self):
        self.window = None

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

    def on_closing():
        # Grab the live session from the page and persist it synchronously,
        # so unsaved tabs survive even an abrupt quit.
        try:
            raw = window.evaluate_js(
                "window.__getSessionJSON ? window.__getSessionJSON() : null"
            )
            if raw:
                api._write_session(json.loads(raw))
        except Exception:
            pass  # debounced saves already wrote a recent copy

    window.events.closing += on_closing
    webview.start(debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
