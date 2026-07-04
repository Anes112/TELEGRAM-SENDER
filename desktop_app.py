import argparse
import os
import sys
import time
import urllib.request


ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TITLE = "Telegram Sender V2"


def show_error(message):
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(DEFAULT_TITLE, message)
        root.destroy()
    except Exception:
        print(message, file=sys.stderr)


def wait_until_ready(url, timeout_seconds=20):
    deadline = time.time() + timeout_seconds
    last_error = None
    while time.time() < deadline:
        try:
            request = urllib.request.Request(f"{url}/api/status", headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception as error:
            last_error = error
            time.sleep(0.4)
    raise RuntimeError(f"Backend Android belum siap / belum bisa diakses: {last_error}")


def parse_args():
    parser = argparse.ArgumentParser(description="Desktop remote panel untuk Telegram Sender V2.")
    parser.add_argument(
        "--remote",
        required=False,
        help="URL backend Android yang sudah jalan, contoh: http://192.168.1.25:5174 atau http://100.x.x.x:5174",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    backend_url = (args.remote or os.environ.get("TELEGRAM_SENDER_BACKEND_URL") or "").rstrip("/")

    try:
        if not backend_url:
            raise RuntimeError(
                "Backend Android belum diset.\n\n"
                "Jalankan backend di HP dulu, lalu buka dari laptop:\n"
                "python desktop_app.py --remote http://IP_HP:5174"
            )

        wait_until_ready(backend_url)

        try:
            import webview
        except ImportError:
            raise RuntimeError(
                "pywebview belum terinstall.\n\n"
                "Jalankan sekali:\n"
                "pip install -r requirements-desktop.txt\n\n"
                "Setelah itu buka lagi:\n"
                "python desktop_app.py"
            )

        webview.create_window(DEFAULT_TITLE, backend_url, width=1280, height=820)
        webview.start(debug=False)
    except Exception as error:
        show_error(str(error))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
