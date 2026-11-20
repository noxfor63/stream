import asyncio
import base64
import io
import json
import os
import re
import sys
from contextlib import contextmanager
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


class NoMusicAudioSession(RuntimeError):
    pass


class NoMusicMediaSession(RuntimeError):
    pass


class PlayerDeclinedCommand(RuntimeError):
    pass


def is_music(identifier):
    name = re.split(r"[\\/]", identifier.strip())[-1].casefold()
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
    image.save(encoded, format="PNG")
    return "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")


async def thumbnail(media):
    from winrt.windows.storage.streams import DataReader

    # Artwork is optional. A broken thumbnail must not stall later key presses.
    try:
        async with asyncio.timeout(1.5):
            reference = media.thumbnail
            if reference is not None:
                with await reference.open_read_async() as stream:
                    if 0 < stream.size <= 16 * 1024 * 1024:
                        with DataReader(stream.get_input_stream_at(0)) as reader:
                            data = bytearray(await reader.load_async(stream.size))
                            reader.read_bytes(data)
                            return data
    except (OSError, RuntimeError, ValueError):
        pass
    return None


def music_session(manager):
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status

    selected = None
    for session in manager.get_sessions():
        try:
            if not is_music(session.source_app_user_model_id):
                continue
            info = session.get_playback_info()
            if info and info.playback_status == Status.PLAYING:
                return session
            if selected is None:
                selected = session
        except OSError:  # A media session can close during enumeration.
            continue
    return selected


def audio_sessions():
    from comtypes import COMError
    from pycaw.pycaw import (
        AudioSession, AudioUtilities, DEVICE_STATE, EDataFlow, IAudioSessionControl2,
    )

    devices = AudioUtilities.GetAllDevices(EDataFlow.eRender.value, DEVICE_STATE.ACTIVE.value)
    for device in devices:
        try:
            sessions = device.AudioSessionManager.GetSessionEnumerator()
            count = sessions.GetCount()
        except COMError:
            continue  # The output may disappear during enumeration.
        for index in range(count):
            try:
                control = sessions.GetSession(index)
                if control is not None:
                    session = AudioSession(control.QueryInterface(IAudioSessionControl2))
                    if session.State != 2:  # AudioSessionStateExpired
                        yield session
            except COMError:
                continue


def is_music_audio(session):
    from psutil import NoSuchProcess, AccessDenied

    try:
        process = session.Process
        return process is not None and is_music(process.name())
    except (NoSuchProcess, AccessDenied):
        return False


def volume(step):
    from comtypes import COMError

    changed = False
    for session in audio_sessions():
        try:
            if is_music_audio(session):
                mixer = session.SimpleAudioVolume
                level = min(1, max(0, mixer.GetMasterVolume() + step))
                mixer.SetMasterVolume(level, None)
                changed = True
        except COMError:
            continue
    if not changed:
        raise NoMusicAudioSession("No matching Windows audio session")


async def media_action(manager, action, font):
    session = music_session(manager)
    if action == "track":
        if session is None:
            return {}
        media = await session.try_get_media_properties_async()
        if media is None or not media.title:
            return {}
        return {"image": card(media.title, media.artist, await thumbnail(media), font)}
    if session is None:
        raise NoMusicMediaSession("No matching Windows media session")
    if action == "toggle":
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status

        info = session.get_playback_info()
        if info.playback_status == Status.PLAYING and info.controls.is_pause_enabled:
            accepted = await session.try_pause_async()
        elif info.playback_status != Status.PLAYING and info.controls.is_play_enabled:
            accepted = await session.try_play_async()
        else:
            accepted = await session.try_toggle_play_pause_async()
    elif action == "next":
        accepted = await session.try_skip_next_async()
    elif action == "previous":
        accepted = await session.try_skip_previous_async()
    else:
        raise ValueError("Unknown action")
    if not accepted:
        raise PlayerDeclinedCommand("Command declined by player")
    return {}


async def main():
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Manager

    manager = None
    if "--check" in sys.argv:
        # Loading the native bindings is sufficient at install time. Check live
        # service availability on demand so an idle desktop can still install.
        from pycaw.pycaw import AudioUtilities
        from winrt.windows.storage.streams import DataReader
        return
    font = Path(os.environ["WINDIR"]) / "Fonts" / "segoeui.ttf"
    for line in sys.stdin:
        request = json.loads(line)
        action = request["action"]
        try:
            if action in ("louder", "quieter"):
                volume(0.05 if action == "louder" else -0.05)
            else:
                async with asyncio.timeout(6):
                    if manager is None:
                        manager = await Manager.request_async()
                    request.update(await media_action(manager, action, font))
        except Exception as exc:
            if isinstance(exc, (OSError, TimeoutError)):
                manager = None
            request["error"] = type(exc).__name__
            print(f"{action}: {exc}", file=sys.stderr)
        print(json.dumps(request), flush=True)


@contextmanager
def windows_apartment():
    # Pycaw imports comtypes. Both Windows APIs use this worker's MTA thread.
    sys.coinit_flags = 0
    from winrt.runtime import ApartmentType, init_apartment, uninit_apartment

    init_apartment(ApartmentType.MULTI_THREADED)
    try:
        yield
    finally:
        uninit_apartment()


if __name__ == "__main__":
    with windows_apartment():
        asyncio.run(main())
