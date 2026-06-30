#!/usr/bin/env bash
set -eo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DISPLAY_ID="${DISPLAY_ID:-:99}"
XORG_CONFIG="${XORG_CONFIG:-/etc/X11/xorg-nvidia-gpu0.conf}"
XORG_LOG="${XORG_LOG:-/var/log/Xorg.99.log}"
CHROME_PATH="${CHROME_PATH:-/home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"
POINT_CLOUD_FILE="${POINT_CLOUD_FILE:-all_points_aligned_icp_baked.tiles/manifest.json}"
STREAM_WIDTH="${STREAM_WIDTH:-1280}"
STREAM_HEIGHT="${STREAM_HEIGHT:-720}"
STREAM_FPS="${STREAM_FPS:-15}"
STREAM_BITRATE="${STREAM_BITRATE:-4000000}"
HEADLESS="${HEADLESS:-false}"

export DISPLAY="$DISPLAY_ID"
export __GLX_VENDOR_LIBRARY_NAME="${__GLX_VENDOR_LIBRARY_NAME:-nvidia}"
export __NV_PRIME_RENDER_OFFLOAD="${__NV_PRIME_RENDER_OFFLOAD:-1}"
export CHROME_PATH HOST PORT POINT_CLOUD_FILE STREAM_WIDTH STREAM_HEIGHT STREAM_FPS STREAM_BITRATE HEADLESS

if [[ ! -x "$CHROME_PATH" ]]; then
  echo "Chrome executable not found or not executable: $CHROME_PATH" >&2
  echo "Set CHROME_PATH or install Puppeteer Chrome 127 first." >&2
  exit 1
fi

if [[ ! -f "$XORG_CONFIG" ]]; then
  echo "Xorg config not found: $XORG_CONFIG" >&2
  echo "Create it from md/GPU系统排查.md before running this script." >&2
  exit 1
fi

if ! pgrep -af "Xorg ${DISPLAY_ID}" >/dev/null; then
  echo "Starting Xorg ${DISPLAY_ID} with $XORG_CONFIG"
  rm -f "/tmp/.X${DISPLAY_ID#:}-lock" "/tmp/.X11-unix/X${DISPLAY_ID#:}"
  Xorg "$DISPLAY_ID" \
    -config "$XORG_CONFIG" \
    -noreset \
    +extension GLX \
    +extension RANDR \
    +extension RENDER \
    -logfile "$XORG_LOG" \
    >/tmp/xorg99.out 2>&1 &
  sleep 2
else
  echo "Xorg ${DISPLAY_ID} is already running"
fi

if [[ -f "$XORG_LOG" ]]; then
  echo "Checking Xorg NVIDIA GLX status"
  grep -iE "ModulePath|NVIDIA\(0\)|NVIDIA GLX|DRISWRAST|swrast" "$XORG_LOG" || true
fi

echo "Starting cloud rendering service"
echo "Project: $PROJECT_DIR"
echo "Chrome: $CHROME_PATH"
echo "Point cloud: $POINT_CLOUD_FILE"
echo "URL: http://$HOST:$PORT"

cd "$PROJECT_DIR"
npm start
