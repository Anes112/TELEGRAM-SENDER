#!/data/data/com.termux/files/usr/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
URL_FILE="$APP_DIR/update-url.txt"
UPDATE_URL="${APP_UPDATE_ZIP_URL:-}"

if [ -z "$UPDATE_URL" ] && [ -f "$URL_FILE" ]; then
  UPDATE_URL="$(tr -d '\r\n' < "$URL_FILE")"
fi

if [ -z "$UPDATE_URL" ]; then
  echo "Isi update-url.txt dulu dengan URL zip update."
  echo "Contoh: https://github.com/USERNAME/REPO/archive/refs/heads/main.zip"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Download update..."
if ! curl -fL "$UPDATE_URL" -o "$TMP_DIR/update.zip"; then
  echo "Gagal download update. Cek update-url.txt, internet, atau repo GitHub."
  exit 1
fi

if [ ! -s "$TMP_DIR/update.zip" ]; then
  echo "File update kosong. Cek update-url.txt."
  exit 1
fi

echo "Extract update..."
unzip -q "$TMP_DIR/update.zip" -d "$TMP_DIR/extract"
SRC_DIR="$(find "$TMP_DIR/extract" -type f -name server.js | head -n 1 | xargs dirname)"

if [ ! -f "$SRC_DIR/server.js" ] || [ ! -d "$SRC_DIR/public" ]; then
  echo "Zip update tidak valid. Harus berisi server.js dan folder public."
  exit 1
fi

echo "Copy file app, data/session tetap aman..."
(
  cd "$SRC_DIR"
  tar --exclude="./data" --exclude="./node_modules" -cf - .
) | (
  cd "$APP_DIR"
  tar -xf -
)

echo "Update dependency..."
cd "$APP_DIR"
npm install --omit=dev

echo "Update selesai."
echo "Jalankan ulang backend manual: bash start_android.sh"
