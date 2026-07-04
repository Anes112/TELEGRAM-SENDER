#!/data/data/com.termux/files/usr/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
INTERVAL_SECONDS="${UPDATE_CHECK_SECONDS:-300}"
HASH_FILE="$APP_DIR/data/.last-update-script.sha256"
mkdir -p "$APP_DIR/data"

echo "Auto update watcher jalan. Interval: ${INTERVAL_SECONDS}s"

while true; do
  URL=""
  if [ -f "$APP_DIR/update-script-url.txt" ]; then
    URL="$(tr -d '\r\n' < "$APP_DIR/update-script-url.txt")"
  fi

  if [ -n "$URL" ]; then
    TMP_SCRIPT="$(mktemp)"
    if curl -fsSL "$URL" -o "$TMP_SCRIPT"; then
      if grep -q "telegram-sender-update-script" "$TMP_SCRIPT"; then
        NEW_HASH="$(sha256sum "$TMP_SCRIPT" | awk '{print $1}')"
        OLD_HASH=""
        [ -f "$HASH_FILE" ] && OLD_HASH="$(cat "$HASH_FILE")"
        if [ "$NEW_HASH" != "$OLD_HASH" ]; then
          echo "Update baru terdeteksi. Jalankan script..."
          echo "$NEW_HASH" > "$HASH_FILE"
          export TELEGRAM_SENDER_APP_DIR="$APP_DIR"
          bash "$TMP_SCRIPT" || true
          if command -v pm2 >/dev/null 2>&1; then
            HOST=0.0.0.0 pm2 restart telegram-backend --update-env || true
          fi
        fi
      else
        echo "URL update bukan raw script valid."
      fi
    else
      echo "Gagal download update script."
    fi
    rm -f "$TMP_SCRIPT"
  else
    echo "update-script-url.txt kosong/belum ada."
  fi

  sleep "$INTERVAL_SECONDS"
done
