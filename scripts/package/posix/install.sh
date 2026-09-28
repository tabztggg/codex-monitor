#!/bin/sh
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET="$HOME/.local/share/codex-monitor"
if [ "$(uname -s)" = Darwin ]; then TARGET="$HOME/Applications/Codex Monitor.app/Contents/Resources/app"; fi
if [ -f "$TARGET/distribution.json" ]; then "$TARGET/codex-monitor" stop; fi
mkdir -p "$(dirname "$TARGET")"
if [ "$SOURCE" != "$TARGET" ]; then
  STAGE="${TARGET}.stage.$$"
  mkdir "$STAGE"
  cp -R "$SOURCE/." "$STAGE/"
  # Only replace a directory that identifies itself as our installed runtime.
  if [ -e "$TARGET" ]; then
    if [ ! -f "$TARGET/distribution.json" ]; then echo 'Target already exists and is not a Monitor installation.' >&2; exit 1; fi
    mv "$TARGET" "${TARGET}.previous.$$"
  fi
  mv "$STAGE" "$TARGET"
fi
if [ "$(uname -s)" = Darwin ]; then
  CONTENTS="$HOME/Applications/Codex Monitor.app/Contents"
  mkdir -p "$CONTENTS/MacOS"
  cp "$TARGET/macos-launcher" "$CONTENTS/MacOS/CodexMonitor"
  cp "$TARGET/macos-Info.plist" "$CONTENTS/Info.plist"
  chmod 755 "$CONTENTS/MacOS/CodexMonitor"
fi
"$TARGET/runtime/node" "$TARGET/dist/launcher/integration.mjs" install "$TARGET"
"$TARGET/codex-monitor" open
