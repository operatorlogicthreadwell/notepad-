#!/bin/bash
# Build a standalone Notepad--.app for macOS (run this on your Mac).
set -euo pipefail
cd "$(dirname "$0")"

python3 -m pip install --upgrade pywebview pyinstaller

python3 -m PyInstaller \
  --noconfirm \
  --windowed \
  --name "Notepad--" \
  --add-data "ui:ui" \
  --osx-bundle-identifier "com.notepadminusminus.app" \
  app.py

echo
echo "Done! Your app is at: dist/Notepad--.app"
echo "Drag it into /Applications and add it to your Dock."
