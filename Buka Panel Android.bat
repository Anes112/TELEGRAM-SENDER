@echo off
cd /d "%~dp0"
python desktop_app.py --remote http://192.168.50.159:5174
pause
