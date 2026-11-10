#!/usr/bin/env bash
# Wrapper that locates and invokes wslc.exe (WSL container CLI) from a WSL/Linux
# bash shell, forwarding all arguments unchanged.
#
# Usage: wslc.sh <wslc-subcommand> [args...]
# Example: wslc.sh list -a
set -euo pipefail

# Known default install location for wslc.exe (ships with WSL >= 2.9.3).
DEFAULT_PATH="/mnt/c/Program Files/WSL/wslc.exe"

find_wslc() {
  if [ -x "$DEFAULT_PATH" ]; then
    echo "$DEFAULT_PATH"
    return 0
  fi

  # Fall back to searching common Windows mount points.
  local candidate
  candidate=$(find /mnt/c/Program\ Files /mnt/c/Program\ Files\ \(x86\) \
    -maxdepth 3 -iname 'wslc.exe' 2>/dev/null | head -n 1 || true)
  if [ -n "${candidate:-}" ]; then
    echo "$candidate"
    return 0
  fi

  # Last resort: ask Windows itself via PATH lookup (requires win32 interop).
  if command -v cmd.exe >/dev/null 2>&1; then
    candidate=$(cmd.exe /c "where wslc.exe" 2>/dev/null | tr -d '\r' | head -n 1 || true)
    if [ -n "${candidate:-}" ]; then
      echo "$candidate"
      return 0
    fi
  fi

  return 1
}

WSLC_BIN="$(find_wslc || true)"

if [ -z "${WSLC_BIN:-}" ]; then
  echo "Error: wslc.exe was not found." >&2
  echo "Ensure WSL is updated (run 'wsl --update' on Windows, requires WSL >= 2.9.3)" >&2
  echo "and that the WSL container feature is installed." >&2
  exit 1
fi

exec "$WSLC_BIN" "$@"
