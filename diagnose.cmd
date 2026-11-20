@echo off
setlocal
chcp 65001 >nul
set "PYTHON=%LOCALAPPDATA%\Noxfor63\YandexMusicDock\venv\Scripts\python.exe"
if not exist "%PYTHON%" (
    > "%~dp0diagnostics.txt" echo Python плагина не найден. Запустите install.cmd из распакованного архива.
    goto report
)
"%PYTHON%" -X utf8 "%~dp0diagnose.py" > "%~dp0diagnostics.txt"
if errorlevel 1 (
    echo Диагностика не завершилась. Сообщение об ошибке отображается выше.
)
:report
type "%~dp0diagnostics.txt"
echo.
echo Отчёт сохранён рядом с diagnose.cmd в файле diagnostics.txt.
pause
