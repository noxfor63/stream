@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "PLUGIN=com.noxfor63.streamdock.browsermedia.sdPlugin"
set "DOCK=%APPDATA%\HotSpot\StreamDock\plugins\%PLUGIN%"
set "EXT=%LOCALAPPDATA%\Noxfor63\BrowserMedia\extension"

if not exist "%~dp0extension\manifest.json" goto incomplete
if not exist "%~dp0%PLUGIN%\manifest.json" goto incomplete
if not exist "%DOCK%" mkdir "%DOCK%" || goto fail
if not exist "%EXT%" mkdir "%EXT%" || goto fail
xcopy "%~dp0%PLUGIN%\*" "%DOCK%" /I /E /Y >nul || goto fail
xcopy "%~dp0extension\*" "%EXT%" /I /E /Y >nul || goto fail
fc /b "%~dp0%PLUGIN%\manifest.json" "%DOCK%\manifest.json" >nul || goto fail
fc /b "%~dp0extension\manifest.json" "%EXT%\manifest.json" >nul || goto fail

echo Плагин скопирован. Перезапустите Stream Dock.
echo.
echo В Opera откройте opera://extensions, включите режим разработчика
echo и нажмите «Загрузить распакованное расширение». Выберите эту папку:
echo "%EXT%"
echo.
echo При обновлении нажмите «Обновить» на карточке расширения.
echo Затем обновите вкладки с плеерами и включите ролик или музыку.
pause
exit /b 0

:incomplete
echo Распакуйте весь ZIP в одну папку и запустите install.cmd ещё раз.
goto failed
:fail
echo Не удалось скопировать файлы. Закройте Stream Dock и повторите установку.
:failed
pause
exit /b 1
