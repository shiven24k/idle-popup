#!/usr/bin/env bash
# Build the Windows installer + portable .exe on Linux.
#
# electron-builder needs Wine to stamp the Windows executable. Rather than
# asking you to install Wine on the host, this runs the official
# electronuserland/builder:wine image, which already has it.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to cross-build the Windows exe." >&2
  echo "Install it, or run 'pnpm dist:win' on Windows itself." >&2
  exit 1
fi

home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
mkdir -p "$home/.cache/electron" "$home/.cache/electron-builder"
mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"

extra=()
# Fedora and other SELinux desktops otherwise deny the container access to the
# bind-mounted project.
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != "Disabled" ]; then
  extra+=(--security-opt label=disable)
fi

docker run --rm "${extra[@]}" \
  --user "$(id -u):$(id -g)" \
  -v "$PWD":/project \
  -w /project \
  -v "$home":/tmp/home \
  -v "$HOME/.cache/electron:/tmp/home/.cache/electron" \
  -v "$HOME/.cache/electron-builder:/tmp/home/.cache/electron-builder" \
  -e HOME=/tmp/home \
  -e USER="${USER:-builder}" \
  -e ELECTRON_CACHE=/tmp/home/.cache/electron \
  -e ELECTRON_BUILDER_CACHE=/tmp/home/.cache/electron-builder \
  electronuserland/builder:wine \
  node ./node_modules/electron-builder/cli.js --win --publish never "$@"
