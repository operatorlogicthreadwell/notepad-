# Tests

Two layers, both runnable without macOS (macOS-only behavior is exercised
manually — see `docs/USER_STORIES.md` for exactly what that covers).

## Backend unit tests (no dependencies)

```bash
python3 tests/test_backend.py
```

Covers file I/O (encodings, BOM, conflict detection, size guards), the
script runner (streaming, exit codes, stop, busy-refusal), and the Apple
Notes HTML↔text conversion.

## Browser UI tests (playwright-core + a Chromium)

The UI runs in any browser via its built-in demo shim (fake file dialogs,
localStorage session, sample Apple Notes), which is what these suites drive.

```bash
npm install playwright-core
CHROMIUM_PATH=/path/to/chromium node tests/browser/test_ui.js     # core editor: 15 tests
CHROMIUM_PATH=/path/to/chromium node tests/browser/test_pdf.js    # PDF viewer: 12 tests
CHROMIUM_PATH=/path/to/chromium node tests/browser/test_run.js    # run console: 7 tests
CHROMIUM_PATH=/path/to/chromium node tests/browser/test_notes.js  # Apple Notes UI: 8 tests
```

`CHROMIUM_PATH` defaults to the Claude Code container's preinstalled
headless shell; point it at any Chromium/Chrome binary elsewhere.
Each suite prints `PASS`/`FAIL` per scenario and a JS-error summary —
expected output is every line `PASS` and `No JS errors.`
