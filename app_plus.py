"""Entry point for Notepad-- Plus — everything except the AI.

Same codebase as app.py with PDF viewing/annotation and Apple Notes
enabled, but the Claude-powered Decide panel switched off.
"""

import os

os.environ["NOTEPAD_EDITION"] = "plus"

import app  # noqa: E402  (env must be set before app.py evaluates EDITION)

if __name__ == "__main__":
    app.main()
