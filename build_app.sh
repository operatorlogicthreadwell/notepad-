#!/bin/bash
# Build both macOS apps from the one codebase (run this on your Mac):
#   Notepad--.app     — classic, true to Notepad++
#   Notepad-- AI.app  — adds PDF viewing/annotation, Apple Notes, Decide
set -euo pipefail
cd "$(dirname "$0")"

python3 -m pip install --upgrade pywebview pyinstaller anthropic

build_one() {
  local NAME="$1" ENTRY="$2" WITH_PDF="$3"

  # --argv-emulation turns Finder "open with" events into argv entries so
  # double-clicked files land in the editor at launch
  python3 -m PyInstaller \
    --noconfirm \
    --windowed \
    --argv-emulation \
    --name "$NAME" \
    --add-data "ui:ui" \
    --osx-bundle-identifier "com.notepadminusminus.$(echo "$NAME" | tr -cd 'a-zA-Z')" \
    "$ENTRY"

  # Register the file types this edition can open, so Finder lists it
  # under "Open With"
  APP_NAME="$NAME" WITH_PDF="$WITH_PDF" python3 - <<'PY'
import os
import plistlib

name = os.environ["APP_NAME"]
with_pdf = os.environ["WITH_PDF"] == "yes"
plist_path = "dist/%s.app/Contents/Info.plist" % name
with open(plist_path, "rb") as f:
    info = plistlib.load(f)

doc_types = [
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
]
if with_pdf:
    doc_types.append({
        "CFBundleTypeName": "PDF Document",
        "CFBundleTypeRole": "Viewer",
        "LSHandlerRank": "Alternate",
        "LSItemContentTypes": ["com.adobe.pdf"],
    })
info["CFBundleDocumentTypes"] = doc_types
info["NSHighResolutionCapable"] = True
# Required for the "wants to control Notes" prompt (AI edition uses it)
info["NSAppleEventsUsageDescription"] = (
    "Notepad-- opens and saves your Apple Notes when you use the "
    "File > Open Apple Note and Send Tab to Apple Notes commands."
)
with open(plist_path, "wb") as f:
    plistlib.dump(info, f)
print("Info.plist updated for %s" % name)
PY

  touch "dist/$NAME.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "dist/$NAME.app" 2>/dev/null || true
}

build_one "Notepad--" "app_classic.py" "no"
build_one "Notepad-- AI" "app.py" "yes"

echo
echo "Done! Two apps in dist/:"
echo "  Notepad--.app      - classic, true to Notepad++"
echo "  Notepad-- AI.app   - PDF annotation, Apple Notes, Decide panel"
echo "Drag either (or both) into /Applications."
