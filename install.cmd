@echo off
setlocal
set "PLUGIN=io.noxfor63.yandexmusic.sdPlugin"
set "VENV=%LOCALAPPDATA%\Noxfor63\YandexMusicDock\venv"
py -3.12 -m venv "%VENV%" || goto fail
"%VENV%\Scripts\python.exe" -m pip install -r "%~dp0%PLUGIN%\requirements.txt" || goto fail
"%VENV%\Scripts\python.exe" "%~dp0%PLUGIN%\player.py" --check || goto fail
xcopy "%~dp0%PLUGIN%" "%APPDATA%\HotSpot\StreamDock\plugins\%PLUGIN%\" /E /I /Y >nul || goto fail
echo Installed. Restart Stream Dock.
pause
exit /b 0
:fail
echo Setup failed. See the error above.
pause
exit /b 1
