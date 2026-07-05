"""Notepad-- : a Notepad++-style editor for macOS.

HTML/JS user interface wrapped in a native window with Python (pywebview).
On macOS the UI renders in the system WKWebView, so the app stays tiny.

Run:            python3 app.py            (add --debug for web inspector)
Build .app:     ./build_app.sh
"""

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
    def read_file(self, path):
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as exc:
            return {"error": str(exc)}
        try:
            text = raw.decode("utf-8")
            encoding = "UTF-8"
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
            encoding = "ANSI"
        return {"content": text, "encoding": encoding}

    def write_file(self, path, content):
        try:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(content)
            return {"ok": True}
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
