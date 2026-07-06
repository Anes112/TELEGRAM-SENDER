# Telegram JS User Sender V2

Versi ini mendukung:

- Banyak akun Telegram.
- Login OTP per akun.
- Detect grup per akun.
- Detect admin/owner dari grup yang sudah disimpan.
- Interval berbeda untuk setiap grup/admin/owner.
- Target kirim ke grup atau admin/owner.
- Stop pengiriman berjalan.
- Quiet hours, pending retry, dan auto reconnect untuk mode HP 24 jam.
- Default kirim grup bisa forward dari post channel, dan grup tertentu bisa pakai teks custom.
- Detect folder Telegram dan blast khusus grup di folder dengan delay/interval terpisah.
- Update online di Android lewat `update_android.sh`.
- Update cepat via raw script online lewat `update_from_script.sh`.

## Jalanin

```powershell
cd C:\Users\WELCOME\Documents\Codex\2026-06-26\jadi\outputs\telegram-js-user-sender-v2
npm install
npm start
```

Buka:

```text
http://127.0.0.1:5174
```

## Jalanin sebagai aplikasi desktop Python

Install dependency window desktop sekali:

```powershell
cd C:\Users\WELCOME\Documents\Codex\2026-06-26\jadi\outputs\telegram-js-user-sender-v2
pip install -r requirements-desktop.txt
```

Desktop ini hanya remote panel. Backend harus sudah jalan di HP, lalu buka:

```powershell
python desktop_app.py --remote http://IP_HP:5174
```

Kalau dijalankan tanpa `--remote`, app akan menolak jalan supaya proses tidak pindah ke laptop.

## Jalanin di Android Termux

```bash
pkg update
pkg install nodejs git
cd telegram-js-user-sender-v2
npm install
HOST=0.0.0.0 npm start
```

Atau:

```bash
bash start_android.sh
```

Buka dari laptop lewat IP HP:

```text
http://IP_HP:5174
```

Biar proses lebih tahan selama Termux tetap hidup:

```bash
termux-wake-lock
bash start_android.sh
```

Kalau mau berhenti, tekan `CTRL+C`.

## Update Online Android

Taruh source app di GitHub/hosting zip, lalu di Android buat file:

```bash
cp update-url.example.txt update-url.txt
nano update-url.txt
```

Isi dengan URL zip update, contoh:

```text
https://github.com/USERNAME/REPO/archive/refs/heads/main.zip
```

Setelah itu kalau ada revisi:

```bash
bash update_android.sh
```

Script update tidak menimpa folder `data/`, jadi session Telegram dan database tetap aman.

## Update Via Script Online

Pakai ini kalau revisinya mau dipaste sebagai script raw/plain text.

Di Android:

```bash
cp update-script-url.example.txt update-script-url.txt
nano update-script-url.txt
bash update_from_script.sh
```

Kalau mau Android cek otomatis tiap 5 menit:

```bash
UPDATE_CHECK_SECONDS=300 bash auto_update_from_script.sh
```

Catatan:

- URL harus raw/plain text, bukan halaman HTML.
- Script harus punya marker `telegram-sender-update-script`.
- Ini lebih cepat dari zip, tapi lebih berisiko karena Android menjalankan script dari internet.
- Folder `data/` tetap aman selama script update tidak menyentuh folder itu.

## Forward channel + teks khusus grup

- Isi `Link post channel default` dengan format `https://t.me/nama_channel/123`.
- Kalau ada grup yang pesannya beda, isi `Teks khusus grup ini` di bagian `Interval Target`.
- Grup yang teks khususnya kosong akan memakai forward channel default.
- Akun pengirim harus bisa akses post channel tersebut.

## Folder Telegram

- Klik `Detect folder akun aktif`.
- Pilih folder Telegram yang isinya grup target.
- Centang grup di folder, lalu klik `Simpan grup folder`.
- Atur `Jeda next folder grup detik`, scheduler, loop, dan interval folder di panel folder.
- Folder grup punya lane sendiri, jadi delay-nya tidak mengikuti grup utama.

## Catatan

- Target yang didetect dari akun tertentu akan dikirim memakai akun itu.
- Kalau akun kedua belum join grup, akun itu tidak otomatis bisa kirim ke grup tersebut.
- DM ke admin/owner bisa gagal kalau privasi Telegram mereka membatasi pesan.
- Data disimpan di folder `data/`.
- Di HP, matikan battery optimization untuk Termux supaya Android tidak mematikan proses.
