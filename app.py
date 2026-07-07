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

# Three editions from one codebase:
#   classic — true to Notepad++: editing, find/replace, session, Run
#   plus    — adds PDF viewing/annotation and Apple Notes (no AI)
#   ai      — everything, including the Claude-powered Decide panel
_edition = os.environ.get("NOTEPAD_EDITION")
if "--classic" in sys.argv:
    _edition = "classic"
elif "--plus" in sys.argv:
    _edition = "plus"
EDITION = _edition if _edition in ("classic", "plus") else "ai"
APP_NAME = "Notepad--"
APP_TITLE = {"classic": "Notepad--", "plus": "Notepad-- Plus",
             "ai": "Notepad-- AI"}[EDITION]


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


# Separate sessions per edition, so one edition never silently drops
# another's tabs (e.g. classic dropping PDF tabs)
SESSION_FILE = os.path.join(
    data_dir(), {"ai": "session.json", "plus": "session-plus.json",
                 "classic": "session-classic.json"}[EDITION])
ANNOS_FILE = os.path.join(data_dir(), "annotations.json")
CONFIG_FILE = os.path.join(data_dir(), "config.json")

DECIDE_SYSTEM = """You are the decision-intelligence layer inside Notepad--, a text editor.
You receive the document the user currently has open (notes, a plan, a draft, meeting
minutes, code — anything) and help them decide what to do.

When asked to analyze, produce a decision brief in markdown with these sections,
omitting any that genuinely don't apply:
## Summary — two or three sentences on what this document is and where it stands.
## Decisions on the table — each open decision you can detect, stated as a question.
## Options & trade-offs — for the main decision(s), the realistic options with pros/cons.
## Risks & unknowns — what could go wrong, what information is missing.
## Recommendation — your best call, with the reasoning in one short paragraph.
## Next actions — a short, concrete checklist.

Ground everything in the document — quote or reference specifics rather than being
generic. If the document doesn't contain enough to work with, say so briefly.
When the user asks a direct question instead, answer it plainly first, then add only
the context needed to act on the answer."""


# Files handed to us on the command line (python3 app.py somefile.txt)
STARTUP_FILES = [a for a in sys.argv[1:] if not a.startswith("-") and os.path.isfile(a)]


class _AiError(Exception):
    """A provider failure with a user-facing explanation."""

    def __init__(self, friendly):
        super().__init__(friendly)
        self.friendly = friendly


class Api:
    """Methods callable from JavaScript via window.pywebview.api.*"""

    def __init__(self):
        self.window = None
        self._proc = None
        self._proc_lock = threading.Lock()
        self._ai_busy = threading.Lock()
        # Files from Finder (Apple "open documents" events). Events that
        # arrive before the UI has booted are queued and handed over when
        # the UI calls ui_ready().
        self._files_lock = threading.Lock()
        self._pending_files = []
        self._ui_is_ready = False

    def get_startup_files(self):
        return STARTUP_FILES

    def ui_ready(self):
        """The UI finished booting: flush any queued Finder-opened files."""
        with self._files_lock:
            self._ui_is_ready = True
            pending, self._pending_files = self._pending_files, []
        return {"pending": pending}

    def open_external(self, paths):
        """Called from the macOS open-documents event handler (any time)."""
        paths = [p for p in paths if os.path.isfile(p)]
        if not paths:
            return
        with self._files_lock:
            if not self._ui_is_ready:
                self._pending_files.extend(paths)
                return
        self._emit_js("window.__openExternal && window.__openExternal(%s)"
                      % json.dumps(paths))

    def get_edition(self):
        return {"edition": EDITION}

    # ---- dialogs -------------------------------------------------------
    def open_dialog(self):
        paths = self.window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True)
        return [str(p) for p in paths] if paths else []

    def folder_dialog(self):
        paths = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        if isinstance(paths, (list, tuple)):
            paths = paths[0] if paths else None
        return str(paths) if paths else None

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

    def write_file_b64(self, path, data_b64):
        """Binary atomic write (exported annotated PDFs)."""
        try:
            data = base64.b64decode(data_b64)
        except Exception as exc:
            return {"error": "Bad data: " + str(exc)}
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".notepad-save-")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            tmp = None
            return {"ok": True}
        except OSError as exc:
            return {"error": str(exc)}
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    # ---- find in files ---------------------------------------------------
    SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__",
                 ".venv", "venv", "dist", "build", ".tox", ".cache"}
    MAX_GREP_FILE = 2 * 1024 * 1024      # skip files over 2 MB
    MAX_GREP_FILES = 20000               # give up on absurd trees
    MAX_GREP_HITS = 1000

    def find_in_files(self, root, query, case_sensitive=False, use_regex=False):
        if not query:
            return {"error": "Nothing to search for."}
        root = os.path.expanduser(root or "")
        if not os.path.isdir(root):
            return {"error": "Not a folder: %s" % (root or "(empty)")}
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            rx = re.compile(query if use_regex else re.escape(query), flags)
        except re.error as exc:
            return {"error": "Bad regular expression: %s" % exc}

        hits, files_scanned, files_matched = [], 0, 0
        truncated = False
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames
                                 if d not in self.SKIP_DIRS and not d.startswith("."))
            for fname in sorted(filenames):
                if fname.startswith("."):
                    continue
                path = os.path.join(dirpath, fname)
                try:
                    if os.path.getsize(path) > self.MAX_GREP_FILE:
                        continue
                    with open(path, "rb") as f:
                        raw = f.read()
                except OSError:
                    continue
                files_scanned += 1
                if b"\x00" in raw[:8192]:
                    continue                      # binary
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    text = raw.decode("latin-1")
                matched = False
                for lineno, line in enumerate(text.split("\n"), 1):
                    if rx.search(line):
                        matched = True
                        hits.append({"path": path, "line": lineno,
                                     "text": line.strip()[:400]})
                        if len(hits) >= self.MAX_GREP_HITS:
                            truncated = True
                            break
                if matched:
                    files_matched += 1
                if truncated or files_scanned >= self.MAX_GREP_FILES:
                    truncated = True
                    break
            if truncated:
                break
        return {"hits": hits, "files_scanned": files_scanned,
                "files_matched": files_matched, "truncated": truncated}

    # ---- folder sidebar ----------------------------------------------------
    def list_dir(self, path):
        path = os.path.expanduser(path or "")
        if not os.path.isdir(path):
            return {"error": "Not a folder: %s" % path}
        entries = []
        try:
            names = os.listdir(path)
        except OSError as exc:
            return {"error": str(exc)}
        for name in names:
            if name.startswith("."):
                continue
            full = os.path.join(path, name)
            entries.append({"name": name, "path": full,
                            "dir": os.path.isdir(full)})
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        return {"entries": entries[:2000]}

    # ---- on-disk change watching (UI polls every few seconds) --------------
    def stat_mtimes(self, paths):
        out = {}
        for p in paths or []:
            try:
                out[p] = os.path.getmtime(p)
            except OSError:
                out[p] = None
        return out

    # ---- custom skin --------------------------------------------------------
    CUSTOM_SKIN_TEMPLATE = """\
/* Notepad-- custom skin.
   Selecting View -> Skin: Custom loads this file. Override any of the
   palette variables from ui/css/style.css here; the ones below are a
   starting point (a teal take on the dark skin). Re-select Skin: Custom
   after editing to reload. */
html[data-theme="custom"] {
  --chrome-bg: #1F2A2E;
  --chrome-bg2: #24333A;
  --chrome-border: #14090A;
  --text: #D8E8E8;
  --accent: #2AB5A5;
  --editor-bg: #172226;
  --editor-fg: #D8E8E8;
  --caret: #2AB5A5;
  --gutter-bg: #1C2A2F;
  --linenum-fg: #5A7A7A;
  --activeline-bg: #203137;
  --selection-bg: rgba(42, 181, 165, .30);
  --syn-keyword: #2AB5A5;
  --syn-string: #C7A96B;
  --syn-comment: #5A7A7A;
  --syn-number: #A2C6A2;
  --syn-def: #7FC7E8;
}
"""

    def get_custom_skin(self):
        path = os.path.join(data_dir(), "custom-skin.css")
        created = False
        if not os.path.exists(path):
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(self.CUSTOM_SKIN_TEMPLATE)
                created = True
            except OSError as exc:
                return {"error": str(exc)}
        try:
            with open(path, "r", encoding="utf-8") as f:
                css = f.read()
        except OSError as exc:
            return {"error": str(exc)}
        if len(css) > 512 * 1024:
            return {"error": "custom-skin.css is too large (max 512 KB)."}
        return {"css": css, "path": path, "created": created}

    # ---- PDF annotations (sidecar storage keyed by file path) ------------
    def _annos_all(self):
        try:
            with open(ANNOS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def annotations_get(self, key):
        return {"data": self._annos_all().get(key)}

    def annotations_save(self, key, data):
        annos = self._annos_all()
        if data and (data.get("highlights") or data.get("notes")):
            annos[key] = data
        else:
            annos.pop(key, None)
        try:
            tmp = ANNOS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(annos, f)
            os.replace(tmp, ANNOS_FILE)
            return {"ok": True}
        except OSError as exc:
            return {"error": str(exc)}

    # ---- decision intelligence (provider-agnostic) ------------------------
    # anthropic — Claude via the official SDK
    # openai    — OpenAI via the official SDK
    # custom    — any OpenAI-compatible endpoint (Ollama, OpenRouter, Groq, …)
    AI_PROVIDERS = ("anthropic", "openai", "custom")
    DEFAULT_MODELS = {"anthropic": "claude-opus-4-8", "openai": "gpt-5",
                      "custom": "llama3.3"}
    ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY",
                "custom": None}

    def _config(self):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = {}
        # migrate the pre-provider config shape (single Anthropic key/model)
        if "api_key" in cfg:
            cfg.setdefault("keys", {}).setdefault("anthropic", cfg.pop("api_key"))
        if "model" in cfg:
            cfg.setdefault("models", {}).setdefault("anthropic", cfg.pop("model"))
        return cfg

    def _write_config(self, cfg):
        tmp = CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        os.replace(tmp, CONFIG_FILE)
        os.chmod(CONFIG_FILE, 0o600)   # the file holds API keys

    def get_ai_config(self):
        cfg = self._config()
        provider = cfg.get("provider") if cfg.get("provider") in self.AI_PROVIDERS else "anthropic"
        keys = cfg.get("keys", {})
        models = cfg.get("models", {})
        env_var = self.ENV_KEYS.get(provider)
        if keys.get(provider):
            key_source = "settings"
        elif env_var and os.environ.get(env_var):
            key_source = "environment"
        elif provider == "custom":
            key_source = "optional"     # local endpoints usually need no key
        else:
            key_source = None
        return {
            "provider": provider,
            "model": models.get(provider) or self.DEFAULT_MODELS[provider],
            "models": {p: models.get(p) or self.DEFAULT_MODELS[p]
                       for p in self.AI_PROVIDERS},
            "has_key": key_source is not None,
            "key_source": key_source,
            "base_url": cfg.get("base_url") or "",
        }

    def set_ai_config(self, provider, api_key, model, base_url):
        cfg = self._config()
        if provider in self.AI_PROVIDERS:
            cfg["provider"] = provider
        target = cfg.get("provider", "anthropic")
        if api_key:                      # empty string = keep the stored key
            cfg.setdefault("keys", {})[target] = api_key
        if model:
            cfg.setdefault("models", {})[target] = model
        if base_url is not None:
            cfg["base_url"] = base_url.strip()
        try:
            self._write_config(cfg)
            return self.get_ai_config()
        except OSError as exc:
            return {"error": str(exc)}

    def ai_analyze(self, text, question):
        cfg = self._config()
        provider = cfg.get("provider") if cfg.get("provider") in self.AI_PROVIDERS else "anthropic"
        keys = cfg.get("keys", {})
        env_var = self.ENV_KEYS.get(provider)
        api_key = keys.get(provider) or (os.environ.get(env_var) if env_var else None)
        model = cfg.get("models", {}).get(provider) or self.DEFAULT_MODELS[provider]
        base_url = (cfg.get("base_url") or "").strip()

        if provider != "custom" and not api_key:
            return {"error": "No API key configured for %s.\n"
                             "Open Decide → AI Provider Settings and paste one."
                             % ("Claude (Anthropic)" if provider == "anthropic" else "OpenAI")}
        if provider == "custom" and not base_url:
            return {"error": "No endpoint configured.\nOpen Decide → AI Provider "
                             "Settings and set the base URL of an OpenAI-compatible "
                             "server (e.g. http://localhost:11434/v1 for Ollama)."}

        if question:
            prompt = ("Here is the document I have open:\n\n<document>\n%s\n</document>\n\n"
                      "My question: %s" % (text, question))
        else:
            prompt = ("Here is the document I have open. Give me the decision brief.\n\n"
                      "<document>\n%s\n</document>" % text)

        if provider == "anthropic":
            return self._start_ai(self._stream_anthropic, api_key, model, None, prompt)
        return self._start_ai(self._stream_openai_compat, api_key, model,
                              base_url if provider == "custom" else None, prompt)

    def _start_ai(self, streamer, api_key, model, base_url, prompt):
        if not self._ai_busy.acquire(blocking=False):
            return {"error": "An analysis is already running.\n"}

        def work():
            try:
                streamer(api_key, model, base_url, prompt)
                self._emit_js("window.__aiDone && window.__aiDone(null)")
            except Exception as exc:  # streamers raise _AiError with a friendly text
                self._fail_ai(getattr(exc, "friendly", None) or str(exc))
            finally:
                self._ai_busy.release()

        threading.Thread(target=work, daemon=True).start()
        return {"ok": True}

    def _emit_ai_chunk(self, chunk):
        if chunk:
            self._emit_js("window.__aiOutput && window.__aiOutput(%s)" % json.dumps(chunk))

    def _stream_anthropic(self, api_key, model, _base_url, prompt):
        try:
            import anthropic
        except ImportError:
            raise _AiError("The 'anthropic' package isn't installed.\n"
                           "Run:  pip3 install anthropic  and restart Notepad--.")
        try:
            client = anthropic.Anthropic(api_key=api_key)
            with client.messages.stream(
                model=model,
                max_tokens=16000,
                thinking={"type": "adaptive"},
                system=DECIDE_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                for chunk in stream.text_stream:
                    self._emit_ai_chunk(chunk)
        except anthropic.AuthenticationError:
            raise _AiError("Your Anthropic API key was rejected — check it in "
                           "Decide → AI Provider Settings.")
        except anthropic.RateLimitError:
            raise _AiError("Rate limited by the Claude API — wait a moment and retry.")
        except anthropic.APIConnectionError:
            raise _AiError("Couldn't reach the Claude API — check your connection.")
        except anthropic.APIStatusError as exc:
            raise _AiError("Claude API error (%s): %s" % (exc.status_code, exc.message))

    def _stream_openai_compat(self, api_key, model, base_url, prompt):
        try:
            import openai
        except ImportError:
            raise _AiError("The 'openai' package isn't installed.\n"
                           "Run:  pip3 install openai  and restart Notepad--.")
        try:
            client = openai.OpenAI(api_key=api_key or "not-needed",
                                   base_url=base_url or None)
            stream = client.chat.completions.create(
                model=model,
                stream=True,
                messages=[{"role": "system", "content": DECIDE_SYSTEM},
                          {"role": "user", "content": prompt}],
            )
            for chunk in stream:
                if chunk.choices and chunk.choices[0].delta:
                    self._emit_ai_chunk(chunk.choices[0].delta.content)
        except openai.AuthenticationError:
            raise _AiError("The API key was rejected — check it in "
                           "Decide → AI Provider Settings.")
        except openai.RateLimitError:
            raise _AiError("Rate limited by the provider — wait a moment and retry.")
        except openai.APIConnectionError:
            raise _AiError("Couldn't reach %s — is the server running?"
                           % (base_url or "api.openai.com"))
        except openai.APIStatusError as exc:
            raise _AiError("Provider error (%s): %s" % (exc.status_code, exc.message))

    def _fail_ai(self, message):
        self._emit_js("window.__aiDone && window.__aiDone(%s)" % json.dumps(message))

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


def install_open_documents_handler(api):
    """Receive files double-clicked in Finder, at launch AND while running.

    PyInstaller's --argv-emulation only translates the open-documents Apple
    Event into argv at process start — a file double-clicked while the app
    was already running produced Finder's "cannot open files in the 'Text
    Document' format" error, because NSApplication routes that event to the
    app delegate's application:openFiles: and pywebview's delegate doesn't
    implement it. (Registering a raw kAEOpenDocuments handler before launch
    doesn't help: NSApplication installs its own during finishLaunching and
    clobbers it.)

    The fix is to graft application:openFiles: onto pywebview's own cocoa
    AppDelegate class, which is the officially routed path. We also reply
    "success" to macOS so the error dialog can never reappear.
    """
    if sys.platform != "darwin":
        return
    try:
        import objc
        import AppKit
    except ImportError:
        return  # pywebview's cocoa backend ships pyobjc; other envs won't

    def open_paths(paths):
        try:
            api.open_external([str(p) for p in paths])
            AppKit.NSApp.activateIgnoringOtherApps_(True)
        except Exception:
            pass  # never let an error travel back into the Apple Event reply

    def application_openFiles_(self, app_obj, filenames):
        try:
            open_paths(list(filenames))
        finally:
            try:
                # NSApplicationDelegateReplySuccess = 0 — tells Launch
                # Services the documents were opened
                app_obj.replyToOpenOrPrint_(0)
            except Exception:
                pass

    try:
        from webview.platforms import cocoa as _cocoa
        delegate_cls = _cocoa.BrowserView.AppDelegate
        objc.classAddMethods(delegate_cls, [
            objc.selector(application_openFiles_,
                          selector=b"application:openFiles:",
                          signature=b"v@:@@"),
        ])
    except Exception as exc:
        # pywebview internals moved — better to run without Finder-open
        # than to crash at startup
        print("open-documents handler not installed:", exc, file=sys.stderr)


def main():
    api = Api()
    window = webview.create_window(
        APP_TITLE,
        ui_file(),
        js_api=api,
        width=1100,
        height=750,
        min_size=(640, 420),
        text_select=True,
    )
    api.window = window
    install_open_documents_handler(api)

    # NOTE: do not call window.evaluate_js from the `closing` event — on macOS
    # it deadlocks the main thread and the app hangs on quit. The UI persists
    # the session continuously (debounced saves plus pagehide/visibility
    # flushes), so there is nothing to do here at close time.
    webview.start(debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
