#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"

printf "Masukkan GROQ API key: "
read -r GROQ_KEY

if [ -z "$GROQ_KEY" ]; then
  echo "Key kosong, batal."
  exit 1
fi

cat > .env <<EOF
GROQ_API_KEY=$GROQ_KEY
EOF

chmod 600 .env
echo "GROQ_API_KEY tersimpan lokal di .env."
