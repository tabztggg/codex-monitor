#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$HERE/codex-monitor" stop
"$HERE/runtime/node" "$HERE/dist/launcher/integration.mjs" uninstall "$HERE"
echo 'Startup entries and shortcuts removed. Usage data has been kept.'
echo 'You can now remove the Codex Monitor application directory.'
