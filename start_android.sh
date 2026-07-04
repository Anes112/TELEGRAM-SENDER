#!/data/data/com.termux/files/usr/bin/bash
set -e

cd "$(dirname "$0")"
export HOST=0.0.0.0
export PORT="${PORT:-5174}"
npm start
