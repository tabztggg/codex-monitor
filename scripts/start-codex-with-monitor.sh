#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: start-codex-with-monitor.sh [--cli] [--] [codex args...]

Starts Codex Monitor in the background, then opens the Codex desktop app when
one is discoverable. Use --cli to run the Codex CLI instead.
EOF
}

cli=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cli)
      cli=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

. "$script_dir/launcher-common.sh"
prepare_node_path

run_codex_cli() {
  codex_path=$(resolve_codex_cli) || {
    printf '%s\n' "Could not find codex in PATH. Set CODEX_BIN or CODEX_MONITOR_CODEX_PATH." >&2
    exit 1
  }

  "$codex_path" "$@"
}

find_linux_desktop_id() {
  for dir in \
    "$HOME/.local/share/applications" \
    "/usr/local/share/applications" \
    "/usr/share/applications" \
    "$HOME/.local/share/flatpak/exports/share/applications" \
    "/var/lib/flatpak/exports/share/applications"; do
    [ -d "$dir" ] || continue

    for file in "$dir"/*.desktop; do
      [ -f "$file" ] || continue
      # The installed monitor shortcut also contains "Codex". Launching it here
      # would recursively reopen this script instead of opening the Codex app.
      case "$file" in
        */codex-with-monitor.desktop) continue ;;
      esac
      if grep -Eq '^Exec=.*start-codex-with-monitor[.]sh' "$file"; then
        continue
      fi
      if grep -Eiq '^(Name=.*Codex|Exec=.*codex)' "$file"; then
        basename "$file" .desktop
        return 0
      fi
    done
  done

  return 1
}

start_codex_desktop_app() {
  case "$(uname -s)" in
    Darwin*)
      for app_root in "$HOME/Applications" /Applications; do
        for app_name in Codex.app ChatGPT.app; do
          app_path="$app_root/$app_name"
          if [ -x "$app_path/Contents/Resources/codex" ] &&
            open -a "$app_path" >/dev/null 2>&1; then
            return 0
          fi
        done
      done
      ;;
    Linux*)
      if command -v gtk-launch >/dev/null 2>&1; then
        desktop_id=$(find_linux_desktop_id || true)
        if [ -n "$desktop_id" ] && gtk-launch "$desktop_id" >/dev/null 2>&1; then
          return 0
        fi
      fi
      ;;
  esac

  run_codex_cli "$@"
}

sh "$script_dir/start-codex-monitor.sh" --no-browser

if [ "$cli" -eq 1 ]; then
  run_codex_cli "$@"
else
  start_codex_desktop_app "$@"
fi
