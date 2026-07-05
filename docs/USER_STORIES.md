# Notepad-- User Stories

What you should be able to do with the app, and how each story is verified.

**Test legend** — `ui`, `pdf`, `run`, `notes`, `torture` = automated browser
suites in `tests/browser/` (run in Chromium against the real UI); `backend` =
`tests/test_backend.py` (Python unit tests); **manual-macOS** = only
verifiable on a real Mac (dialogs, Finder, Notes automation, quitting).

Beyond the suites, the code has been through ESLint/pyflakes static
analysis and three independent adversarial reviews (frontend state
machine, Python backend, JS↔Python bridge contract).

## Editing

| As a user, I can… | Verified by |
|---|---|
| Type in a fast plain-text editor with line numbers, current-line highlight, bracket matching, auto-indent | `ui` |
| Work in many tabs; the active tab is visually distinct; unsaved tabs show a red dot, saved ones blue | `ui` |
| See live status: length, lines, cursor Ln/Col, selection size, line-ending style, encoding | `ui`, `backend` |
| Toggle word wrap and line numbers; zoom text in/out; settings persist | `ui` |
| Get syntax highlighting for 11 languages, auto-detected by extension or picked from the Language menu | `ui` |
| Undo/redo, including a single undo step for a whole Replace All | `ui` |

## Files

| As a user, I can… | Verified by |
|---|---|
| Create, open, save, and Save-As files via native macOS dialogs | shim-level in `ui`; dialogs **manual-macOS** |
| Open files with original encoding respected (UTF-8, UTF-8-BOM, ANSI) and saved back byte-faithfully | `backend` |
| Keep my Windows (CRLF) or Unix (LF) line endings across open/save | `backend`, `ui` |
| Be warned before overwriting a file another program changed while I had it open | `backend` |
| Be refused gracefully (not hung) when opening absurdly large files | `backend` |
| Right-click a .py/.txt/.sh/PDF in Finder → Open With → Notepad--, and have double-clicked files open at launch | **manual-macOS** (associations registered by `build_app.sh`) |

## Never losing work

| As a user, I can… | Verified by |
|---|---|
| Quit any time — open tabs *and unsaved text* return exactly on relaunch (Notepad++-style session) | `ui`; quit-path **manual-macOS** |
| Get a Save / Don't Save / Cancel prompt when closing a dirty tab; Esc or click-away means Cancel | `ui` |
| Cancel a Close-All sweep midway and keep the remaining tabs | `ui` |
| Restore each tab's cursor position, scroll, language, and the active tab | `ui` |

## Find & replace

| As a user, I can… | Verified by |
|---|---|
| Find with live match highlighting and a match count; wrap-around next/previous | `ui` |
| Use regular expressions, including capture groups (`$1`) in replacements, case toggle, and cross-line patterns | `ui` |
| Replace one-at-a-time or all-at-once; jump to a line with ⌘L | `ui` |

## PDFs

| As a user, I can… | Verified by |
|---|---|
| Open a PDF in a read-only viewer tab: lazy page rendering, page nav, zoom, fit-width (re-fits on window resize) | `pdf` |
| Select and copy text off the rendered page | `pdf` (text layer present) |
| Search a PDF with the same ⌘F bar — counts, highlights, jump-to-match across pages; go to a page with ⌘L, landing aligned | `pdf` |
| Extract all text into an editable tab (File → Open PDF as Text / "Open as Text" button) | `pdf` |
| Have PDF tabs restore with last page and zoom; replace/editing politely refused | `pdf` |
| Open a malicious PDF without it executing script in the app (CVE-2024-4367 mitigated via `isEvalSupported:false`) | code-level mitigation; not exploit-tested |

## Running scripts

| As a user, I can… | Verified by |
|---|---|
| Press ⌘R to run the current Python or shell file (auto-saved first) with stdout/stderr streaming live, color-coded, with exit-code status | `backend` (real processes), `run` (console UI) |
| Run one-off shell commands (⇧⌘R) in my file's directory, with command history | `backend`, `run` |
| Stop a runaway process with the Stop button; be refused a second concurrent run | `backend` |
| See a helpful error for unrunnable file types | `backend` |

## Apple Notes

| As a user, I can… | Verified by |
|---|---|
| Browse my Apple Notes (newest first, filter-as-you-type, folder shown) and open one as a tab | `notes` (UI with demo data); real Notes **manual-macOS** |
| Edit a note and ⌘S it back into Apple Notes; the tab title follows the note's first line | `notes`; osascript path **manual-macOS** |
| Send any text tab to Apple Notes as a new note | `notes` |
| Trust the formatting conversion: Notes HTML ⇄ plain text round-trips stably (lists become `- item`) | `backend` |
| Get a clear fix-it message if I denied the automation permission | `backend` (error mapping) |

## Known gaps / honest caveats

- **macOS-native paths are manually tested only**: real file dialogs, quit
  behavior, Finder associations, the Notes permission prompt and osascript
  calls, and the PyInstaller bundle itself.
- ⌘W may be captured by macOS as "close window" before the app sees it;
  session restore makes this non-destructive.
- Rich formatting in Apple Notes (bold, images, tables) is flattened to
  plain text when edited here.
- No file-change *watching* while a file is open (conflicts are only
  detected at save time); scanned/image-only PDFs have no text to search
  or extract.
