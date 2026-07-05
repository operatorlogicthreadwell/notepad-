"""Unit tests for app.py's backend logic (file I/O, script runner, Apple Notes
conversion). Runs anywhere — pywebview is stubbed out, and macOS-only paths
(osascript) are asserted to fail gracefully off-Mac.

Run:  python3 tests/test_backend.py
"""

import importlib.util
import json
import os
import sys
import tempfile
import time
import types

sys.modules["webview"] = types.SimpleNamespace(OPEN_DIALOG=1, SAVE_DIALOG=2)
APP_PY = os.path.join(os.path.dirname(__file__), "..", "app.py")
spec = importlib.util.spec_from_file_location("app", APP_PY)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

PASS = 0


def ok(label):
    global PASS
    PASS += 1
    print("PASS " + label)


class FakeWindow:
    def __init__(self):
        self.calls = []

    def evaluate_js(self, script):
        self.calls.append(script)


def wait_for_done(window, seconds=10):
    for _ in range(int(seconds * 10)):
        if any("__runDone" in c for c in window.calls):
            return True
        time.sleep(0.1)
    return False


# ---- encoding & file I/O -------------------------------------------------
api = app.Api()
d = tempfile.mkdtemp()

p = os.path.join(d, "ansi.txt")
open(p, "wb").write("caf\xe9 cr\xe8me".encode("latin-1"))
r = api.read_file(p)
assert r["encoding"] == "ANSI", r
api.write_file(p, r["content"], r["encoding"], None)
assert open(p, "rb").read() == "caf\xe9 cr\xe8me".encode("latin-1")
ok("ANSI file round-trips byte-identically")

p2 = os.path.join(d, "bom.txt")
open(p2, "wb").write(b"\xef\xbb\xbfhello")
r2 = api.read_file(p2)
assert r2["encoding"] == "UTF-8-BOM" and r2["content"] == "hello", r2
api.write_file(p2, r2["content"], r2["encoding"], None)
assert open(p2, "rb").read() == b"\xef\xbb\xbfhello"
ok("UTF-8 BOM detected, hidden from editor, preserved on save")

w3 = api.write_file(p, "smile \U0001F600", "ANSI", None)
assert w3["encoding"] == "UTF-8", w3
ok("unencodable char falls back to UTF-8 and reports new encoding")

r4 = api.read_file(p)
open(p, "wb").write(b"external change")
os.utime(p, (time.time() + 5, time.time() + 5))
w4 = api.write_file(p, "mine", r4["encoding"], r4["mtime"])
assert w4.get("conflict") is True, w4
assert api.write_file(p, "mine", "UTF-8", None).get("ok")
ok("save detects external modification; explicit overwrite works")

p5 = os.path.join(d, "big.txt")
with open(p5, "wb") as f:
    f.truncate(65 * 1024 * 1024)
r5 = api.read_file(p5)
assert "error" in r5 and "64 MB" in r5["error"], r5
ok("oversized file refused with clear message")

p6 = os.path.join(d, "u16.txt")
open(p6, "wb").write("héllo utf16".encode("utf-16"))
r6 = api.read_file(p6)
assert r6["encoding"] == "UTF-16" and r6["content"] == "héllo utf16", r6
api.write_file(p6, r6["content"], r6["encoding"], None)
assert open(p6, "rb").read().decode("utf-16") == "héllo utf16"
ok("UTF-16 BOM detected and round-trips")

# atomic save: a failed write must never truncate the original
p7 = os.path.join(d, "precious.txt")
open(p7, "w").write("original content")
r7 = api.write_file(os.path.join(d, "no-such-dir", "x.txt"), "y", "UTF-8", None)
assert "error" in r7
assert open(p7).read() == "original content"
ok("atomic save: failures cannot damage existing files")

# ---- script runner ---------------------------------------------------------
api = app.Api()
api.window = FakeWindow()
script = os.path.join(d, "hello.py")
open(script, "w").write(
    "import sys\nprint('hello from python')\n"
    "print('oops', file=sys.stderr)\nsys.exit(3)\n")
assert api.run_file(script, "python").get("ok")
assert wait_for_done(api.window)
joined = "\n".join(api.window.calls)
assert "hello from python" in joined and "oops" in joined and '"err"' in joined
assert "__runDone(3)" in joined
ok("python file runs; stdout/stderr streamed; exit code delivered")

api2 = app.Api()
api2.window = FakeWindow()
assert api2.run_command("echo in:$PWD", d).get("ok")
assert wait_for_done(api2.window)
assert any("in:" in c and (d in c or os.path.realpath(d) in c) for c in api2.window.calls)
ok("shell command runs in the requested directory")

api3 = app.Api()
api3.window = FakeWindow()
assert api3.run_command("sleep 30", None).get("ok")
assert "already running" in api3.run_command("echo x", None).get("error", "")
assert api3.run_stop().get("ok") is True
time.sleep(0.5)
assert api3._proc.poll() is not None
ok("concurrent run refused; Stop terminates the process")

r = app.Api().run_file(os.path.join(d, "data.csv"), "text")
assert "Run Shell Command" in r.get("error", ""), r
ok("unrunnable file type gets a helpful error")

# ---- Apple Notes conversion ------------------------------------------------
api = app.Api()
body = ('<div><h1>Shopping List</h1></div><div><br></div>'
        '<ul><li>milk &amp; eggs</li><li>caf\xe9 beans</li></ul>'
        '<div>done by 5 &lt;pm&gt;</div>')
text = api._html_to_text(body)
assert text == "Shopping List\n\n- milk & eggs\n- caf\xe9 beans\n\ndone by 5 <pm>", repr(text)
ok("Notes HTML flattens to readable plain text")

html = api._text_to_html("Title\n\na < b & c")
assert html == "<div>Title</div><div><br></div><div>a &lt; b &amp; c</div>", html
ok("plain text converts to escaped Notes HTML")

assert api._html_to_text(api._text_to_html("line1\n\nline2 & three")) == "line1\n\nline2 & three"
ok("Notes text/HTML round-trip is stable")

# blank-line runs survive a round-trip exactly (no silent reflow on save)
for sample in ["a\n\n\n\nb", "a\n\nb\n\n\nc", "solo"]:
    assert api._html_to_text(api._text_to_html(sample)) == sample, repr(sample)
ok("multiple consecutive blank lines round-trip unchanged")

if sys.platform != "darwin":
    r = api.notes_list()
    assert "error" in r and "macOS" in r["error"], r
    ok("Notes integration errors gracefully off-macOS")

# ---- provider-agnostic AI config -------------------------------------------
app.CONFIG_FILE = os.path.join(tempfile.mkdtemp(), "config.json")
api = app.Api()
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("OPENAI_API_KEY", None)

cfg = api.get_ai_config()
assert cfg["provider"] == "anthropic" and cfg["model"] == "claude-opus-4-8", cfg
assert not cfg["has_key"]
ok("default provider is Anthropic with sane model default")

r = api.set_ai_config("openai", "sk-oai-1", "gpt-5", "")
assert r["provider"] == "openai" and r["has_key"] and r["key_source"] == "settings", r
r = api.set_ai_config("anthropic", "sk-ant-1", "", "")
assert r["provider"] == "anthropic" and r["has_key"], r
r = api.set_ai_config("openai", "", "", "")
assert r["has_key"], "openai key forgotten when switching back"
ok("per-provider keys and models are remembered independently")

r = api.set_ai_config("custom", "", "llama3.3", "http://localhost:11434/v1")
assert r["has_key"] and r["key_source"] == "optional", r
assert r["base_url"] == "http://localhost:11434/v1", r
ok("custom endpoints need no key; base_url stored")

api.set_ai_config("custom", "", "", "")   # clear base_url
r = api.ai_analyze("text", None)
assert "error" in r and "base URL" in r["error"], r
ok("custom provider without endpoint gets setup guidance")

r = api.set_ai_config("bogus-provider", "", "", None)
assert r["provider"] in app.Api.AI_PROVIDERS, r
ok("unknown provider names are rejected safely")

# legacy single-key config migrates to the anthropic slot
with open(app.CONFIG_FILE, "w") as f:
    json.dump({"api_key": "sk-legacy", "model": "claude-opus-4-8"}, f)
cfg = api.get_ai_config()
assert cfg["provider"] == "anthropic" and cfg["has_key"] and cfg["key_source"] == "settings", cfg
ok("pre-provider config migrates automatically")

print("\n%d backend tests passed" % PASS)
