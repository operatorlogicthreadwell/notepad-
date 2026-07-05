"""Entry point for Notepad-- Classic — the edition true to Notepad++.

Same codebase as app.py with the AI-evolved features (PDF viewing and
annotation, Apple Notes, the Decide panel) switched off.
"""

import os

os.environ["NOTEPAD_EDITION"] = "classic"

import app  # noqa: E402  (env must be set before app.py evaluates EDITION)

if __name__ == "__main__":
    app.main()
