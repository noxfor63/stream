"""Read-only diagnostics for the Windows Stream Dock plugin."""
import asyncio
import json
import os
import re
import sys
from collections import deque
from pathlib import Path, PureWindowsPath


PLUGIN = "io.noxfor63.yandexmusic.sdPlugin"


def public_id(identifier):
    # A Win32 app ID can be an absolute path to the executable.
    return re.sub(r"[^\w.!+() -]", "?", PureWindowsPath(identifier).name)[:150]


def problem(exc):
    code = getattr(exc, "winerror", None)
    return type(exc).__name__ if code is None else f"{type(exc).__name__} (0x{code & 0xffffffff:08X})"


async def media_report(player):
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager

    manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    sessions = list(manager.get_sessions())
    print(f"Медиасессий Windows: {len(sessions)}")
    selected = player.music_session(manager)
    if selected is not None:
        print("Плагин выбрал медиасессию:", public_id(selected.source_app_user_model_id))
        properties = await selected.try_get_media_properties_async()
        if properties is None:
            print("Windows не вернула сведения о треке.")
        else:
            print("Название / исполнитель / обложка доступны:",
                  " / ".join("да" if value else "нет" for value in
                             (properties.title, properties.artist, properties.thumbnail)))
    else:
        print("Плагин не нашёл медиасессию Яндекс Музыки.")
    for session in sessions:
        name = public_id(session.source_app_user_model_id)
        if "yandex" in name.casefold() or "яндекс" in name.casefold():
            print("Идентификатор приложения Яндекса:", name)


def show_trace():
    log = Path(os.environ["LOCALAPPDATA"]) / "Noxfor63" / "YandexMusicDock" / "dock.log"
    if not log.is_file():
        print("Журнал связи отсутствует. Откройте Stream Dock и нажмите кнопку плагина.")
        return
    print("Последние события связи со Stream Dock:")
    with log.open(encoding="utf-8", errors="replace") as source:
        for line in deque(source, maxlen=15):
            print(line.strip())


def main():
    from datetime import datetime

    print("Диагностика Stream Dock / Яндекс Музыка", datetime.now().isoformat(timespec="seconds"))
    print(f"Python {sys.version.split()[0]}")
    folder = Path(os.environ["APPDATA"]) / "HotSpot" / "StreamDock" / "plugins" / PLUGIN
    try:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8-sig"))
        print("Установленная версия:", manifest.get("Version", "?"))
    except (OSError, ValueError) as exc:
        print("Не удалось прочитать установленный manifest.json:", problem(exc))
    try:
        show_trace()
    except OSError as exc:
        print("Журнал связи недоступен:", problem(exc))

    # Run the same matching logic shipped in this diagnostic archive. This also
    # works when diagnosing an older installed worker without the new helpers.
    sys.path.insert(0, str(Path(__file__).resolve().parent / PLUGIN))
    try:
        import player
    except ImportError as exc:
        print("Библиотеки плеера недоступны:", problem(exc))
        return
    try:
        with player.windows_apartment():
            try:
                asyncio.run(asyncio.wait_for(media_report(player), timeout=10))
            except Exception as exc:
                print("Ошибка при чтении медиасессий Windows:", problem(exc))
            try:
                slider = player.app_volume_slider()
                if slider:
                    percent = round(100 * (slider.CurrentValue - slider.CurrentMinimum) / (slider.CurrentMaximum - slider.CurrentMinimum))
                    print(f"Ползунок громкости в Яндекс Музыке: {percent}%")
                else:
                    print("Ползунок не найден. Откройте окно Яндекс Музыки и покажите регулятор громкости.")
            except Exception as exc:
                print("Ошибка чтения ползунка приложения:", problem(exc))
    except Exception as exc:
        print("Ошибка инициализации Windows Runtime:", problem(exc))


if __name__ == "__main__":
    main()
