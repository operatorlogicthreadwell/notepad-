#!/bin/bash
# Build a standalone Notepad--.app for macOS (run this on your Mac).
set -euo pipefail
cd "$(dirname "$0")"

python3 -m pip install --upgrade pywebview pyinstaller

# --argv-emulation turns Finder "open with" events into argv entries so
# double-clicked files land in the editor at launch
python3 -m PyInstaller \
  --noconfirm \
  --windowed \
  --argv-emulation \
  --name "Notepad--" \
  --add-data "ui:ui" \
  --osx-bundle-identifier "com.notepadminusminus.app" \
  app.py

# Register the file types Notepad-- can open, so Finder lists it under
# "Open With" for text, code, and PDF files
python3 - <<'PY'
import plistlib

plist_path = "dist/Notepad--.app/Contents/Info.plist"
with open(plist_path, "rb") as f:
    info = plistlib.load(f)

info["CFBundleDocumentTypes"] = [
    {
        "CFBundleTypeName": "Text Document",
        "CFBundleTypeRole": "Editor",
        "LSHandlerRank": "Alternate",
        "LSItemContentTypes": [
            "public.plain-text", "public.text", "public.source-code",
            "public.python-script", "public.shell-script", "public.script",
            "public.json", "public.xml", "public.yaml",
            "net.daringfireball.markdown", "public.comma-separated-values-text",
            "public.log", "public.data",
        ],
    },
    {
        "CFBundleTypeName": "PDF Document",
        "CFBundleTypeRole": "Viewer",
        "LSHandlerRank": "Alternate",
        "LSItemContentTypes": ["com.adobe.pdf"],
    },
]
info["NSHighResolutionCapable"] = True

with open(plist_path, "wb") as f:
    plistlib.dump(info, f)
print("Info.plist: registered document types")
PY

# Refresh LaunchServices so Finder notices the new associations
touch "dist/Notepad--.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "dist/Notepad--.app" 2>/dev/null || true

echo
echo "Done! Your app is at: dist/Notepad--.app"
echo "Drag it into /Applications and add it to your Dock."
echo "Right-click any .py/.txt/.sh file -> Open With -> Notepad--."
