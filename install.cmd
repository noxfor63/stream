@echo off
setlocal EnableExtensions
set "PLUGIN=io.noxfor63.yandexmusic.sdPlugin"
set "DEST=%APPDATA%\HotSpot\StreamDock\plugins\%PLUGIN%"
set "VENV=%LOCALAPPDATA%\Noxfor63\YandexMusicDock\venv"
set "USER_PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
set "CHECK=import sys, sysconfig; sys.exit(0 if sys.version_info[:2] == (3, 12) and sysconfig.get_platform() == 'win-amd64' else 1)"

if exist "%VENV%\Scripts\python.exe" (
    "%VENV%\Scripts\python.exe" -c "%CHECK%" >nul 2>&1
    if not errorlevel 1 goto dependencies
)
call :find_python
if not errorlevel 1 goto create_venv

where winget.exe >nul 2>&1 || goto need_python
echo Installing Python 3.12 x64 for your Windows account...
winget install --id Python.Python.3.12 --exact --source winget --scope user --architecture x64 --accept-package-agreements --accept-source-agreements
call :find_python
if errorlevel 1 goto need_python

:create_venv
"%PYTHON_CMD%" %PYTHON_ARGS% -m venv "%VENV%" || goto fail

:dependencies
"%VENV%\Scripts\python.exe" -m pip install -r "%~dp0%PLUGIN%\requirements.txt" || goto fail
"%VENV%\Scripts\python.exe" "%~dp0%PLUGIN%\player.py" --check || goto fail
if not exist "%DEST%" mkdir "%DEST%" || goto fail
xcopy "%~dp0%PLUGIN%\*" "%DEST%" /E /I /Y >nul || goto fail
fc /b "%~dp0%PLUGIN%\manifest.json" "%DEST%\manifest.json" >nul || goto fail
fc /b "%~dp0%PLUGIN%\index.js" "%DEST%\index.js" >nul || goto fail
fc /b "%~dp0%PLUGIN%\player.py" "%DEST%\player.py" >nul || goto fail
echo Installed. Restart Stream Dock.
pause
exit /b 0

:find_python
set "PYTHON_ARGS="
set "PYTHON_CMD=%USER_PYTHON%"
if exist "%PYTHON_CMD%" (
    "%PYTHON_CMD%" -c "%CHECK%" >nul 2>&1
    if not errorlevel 1 exit /b 0
)
set "PYTHON_CMD=py.exe"
set "PYTHON_ARGS=-3.12-64"
"%PYTHON_CMD%" %PYTHON_ARGS% -c "%CHECK%" >nul 2>&1
exit /b %errorlevel%

:need_python
echo Python 3.12 x64 is required. Install the Windows installer ^(64-bit^) from:
echo https://www.python.org/downloads/release/python-31210/
echo Then run install.cmd again.
:fail
echo Setup failed. See the error above.
pause
exit /b 1
