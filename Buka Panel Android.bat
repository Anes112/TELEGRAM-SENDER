@echo off
cd /d "%~dp0"
set DEFAULT_IP=192.168.50.159
set /p ANDROID_IP=Masukkan IP Android [%DEFAULT_IP%]: 
if "%ANDROID_IP%"=="" set ANDROID_IP=%DEFAULT_IP%
echo Membuka panel dari http://%ANDROID_IP%:5174
python desktop_app.py --remote http://%ANDROID_IP%:5174
pause
