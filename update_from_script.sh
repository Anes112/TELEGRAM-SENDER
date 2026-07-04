#!/data/data/com.termux/files/usr/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
URL_FILE="$APP_DIR/update-script-url.txt"
SCRIPT_URL="${APP_UPDATE_SCRIPT_URL:-}"

if [ -z "$SCRIPT_URL" ] && [ -f "$URL_FILE" ]; then
  SCRIPT_URL="$(tr -d '\r\n' < "$URL_FILE")"
fi

if [ -z "$SCRIPT_URL" ]; then
  echo "Isi update-script-url.txt dulu dengan URL raw script update."
  echo "Pakai URL raw/plain text, bukan halaman HTML biasa."
  exit 1
fi

TMP_SCRIPT="$(mktemp)"
cleanup() {
  rm -f "$TMP_SCRIPT"
}
trap cleanup EXIT

echo "Download update script..."
curl -fsSL "$SCRIPT_URL" -o "$TMP_SCRIPT"

if ! grep -q "telegram-sender-update-script" "$TMP_SCRIPT"; then
  echo "Script ditolak: marker telegram-sender-update-script tidak ditemukan."
  echo "Kemungkinan URL bukan raw/plain text atau script salah."
  exit 1
fi

echo "Jalankan update script..."
export TELEGRAM_SENDER_APP_DIR="$APP_DIR"
bash "$TMP_SCRIPT"

if command -v pm2 >/dev/null 2>&1; then
  HOST=0.0.0.0 pm2 restart telegram-backend --update-env || true
fi

echo "Update script selesai."
