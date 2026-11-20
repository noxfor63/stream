import asyncio
import base64
import io
import json
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def is_music(identifier):
    name = re.split(r"[\\/]", identifier)[-1].casefold()
    return bool(re.search(r"(?:^|[.!_-])(?:yandex[ ._-]*(?:desktop[ ._-]*)?music|яндекс[ ._-]*музыка)(?:$|[.!_-])", name))


def fit(draw, value, font):
    if draw.textlength(value, font=font) <= 136:
        return value
    while value and draw.textlength(value + "…", font=font) > 136:
        value = value[:-1]
    return value + "…"


def card(title, artist, artwork, font_path):
    image = Image.new("RGB", (144, 144), "#222028")
    if artwork:
        try:
            with Image.open(io.BytesIO(artwork)) as cover:
                image = ImageOps.fit(cover.convert("RGB"), image.size)
        except (OSError, ValueError):
            pass
    draw = ImageDraw.Draw(image, "RGBA")
    draw.rectangle((0, 93, 144, 144), fill=(10, 10, 10, 210))
    for value, size, y, color in ((title, 18, 94, "white"), (artist, 16, 119, "#ffdc63")):
        font = ImageFont.truetype(str(font_path), size)
        draw.text((4, y), fit(draw, value, font), font=font, fill=color)
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")


async def thumbnail(reference):
    from winrt.windows.storage.streams import DataReader

    if reference:
        try:
            with await reference.open_read_async() as stream:
                if 0 < stream.size <= 16 * 1024 * 1024:
                    with DataReader(stream.get_input_stream_at(0)) as reader:
                        data = bytearray(await reader.load_async(stream.size))
                        reader.read_bytes(data)
                        return data
        except OSError:
            pass
    return None


def volume(step):
    from pycaw.pycaw import AudioUtilities
    from psutil import NoSuchProcess, AccessDenied

    changed = False
    for session in AudioUtilities.GetAllSessions():
        try:
            process = session.Process
            if process and is_music(process.name()):
                mixer = session.SimpleAudioVolume
                level = min(1, max(0, mixer.GetMasterVolume() + step))
                mixer.SetMasterVolume(level, None)
                changed = True
        except (NoSuchProcess, AccessDenied):
            continue
    if not changed:
        raise RuntimeError("Audio session unavailable")


async def main():
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
    from pycaw.pycaw import AudioUtilities

    manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    if "--check" in sys.argv:
        manager.get_sessions()
        AudioUtilities.GetAllSessions()
        return
    font = Path(os.environ["WINDIR"]) / "Fonts" / "segoeui.ttf"
    for line in sys.stdin:
        request = json.loads(line)
        action = request["action"]
        try:
            if action in ("louder", "quieter"):
                volume(0.05 if action == "louder" else -0.05)
            else:
                session = next((s for s in manager.get_sessions() if is_music(s.source_app_user_model_id)), None)
                if action == "track":
                    if session:
                        media = await session.try_get_media_properties_async()
                        if media.title:
                            request["image"] = card(media.title, media.artist, await thumbnail(media.thumbnail), font)
                elif session:
                    commands = {"next": session.try_skip_next_async,
                                "previous": session.try_skip_previous_async,
                                "toggle": session.try_toggle_play_pause_async}
                    if not await commands[action]():
                        raise RuntimeError("Command declined")
                else:
                    raise RuntimeError("Player unavailable")
        except Exception as exc:
            request["error"] = type(exc).__name__
            print(f"{action}: {exc}", file=sys.stderr)
        print(json.dumps(request), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
