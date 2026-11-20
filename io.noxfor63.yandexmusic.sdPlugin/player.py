import asyncio
import base64
import io
import json
import os
import re
import sys
import time
from functools import lru_cache
from contextlib import contextmanager
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


class NoAppVolumeSlider(RuntimeError):
    pass


class NoMusicMediaSession(RuntimeError):
    pass


class PlayerDeclinedCommand(RuntimeError):
    pass


def is_music(identifier):
    name = re.split(r"[\\/]", identifier.strip())[-1].casefold()
    return bool(re.search(r"(?:^|[.!_-])(?:yandex[ ._-]*(?:desktop[ ._-]*)?music|яндекс[ ._-]*музыка)(?:$|[.!_-])", name))


def fit(draw, value, font, width):
    if draw.textlength(value, font=font) <= width:
        return value
    while value and draw.textlength(value + "…", font=font) > width:
        value = value[:-1]
    return value + "…"


KEY_SIZE = 144


def card_canvas(title, artist, artwork, font_path, columns, rows):
    width, height = columns * KEY_SIZE, rows * KEY_SIZE
    image = Image.new("RGB", (width, height), "#222028")
    if artwork:
        try:
            with Image.open(io.BytesIO(artwork)) as cover:
                image = ImageOps.fit(cover.convert("RGB"), image.size)
        except (OSError, ValueError):
            pass
    draw = ImageDraw.Draw(image, "RGBA")
    scale = min(columns, rows, 2)
    top = height - 51 * scale
    draw.rectangle((0, top, width, height), fill=(10, 10, 10, 210))
    for value, size, offset, color in ((title, 18, 1, "white"), (artist, 16, 26, "#ffdc63")):
        font = ImageFont.truetype(str(font_path), size * scale)
        draw.text((4 * scale, top + offset * scale), fit(draw, value, font, width - 8 * scale),
                  font=font, fill=color)
    return image


def png(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


CORNERS = {"top-left": (0, 0), "top-right": (1, 0),
           "bottom-left": (0, 1), "bottom-right": (1, 1)}


def rectangles(cards):
    """Combine only solid, edge-connected rectangles on the same device."""
    devices = {}
    for card in cards:
        corner = CORNERS.get(card.get("coverCorner"))
        if corner is not None:
            yield 2, 2, [(card["context"], *corner)]
            continue
        x, y = card.get("column"), card.get("row")
        device = card.get("device")
        if not device or type(x) is not int or type(y) is not int:
            yield 1, 1, [(card["context"], 0, 0)]
            continue
        grid = devices.setdefault(device, {})
        grid.setdefault((x, y), []).append(card["context"])
    for grid in devices.values():
        while grid:
            first = next(iter(grid))
            queue = [first]
            group = []
            while queue:
                x, y = queue.pop()
                for context in grid.pop((x, y), ()):
                    group.append((context, x, y))
                    queue.extend(pos for pos in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)) if pos in grid)
            left, right = min(x for _, x, _ in group), max(x for _, x, _ in group)
            top, bottom = min(y for _, _, y in group), max(y for _, _, y in group)
            w, h = right - left + 1, bottom - top + 1
            if len(group) == len({(x, y) for _, x, y in group}) == w * h:
                yield w, h, [(c, x-left, y-top) for c, x, y in group]
            else:
                for c, _, _ in group:
                    yield 1, 1, [(c, 0, 0)]


@lru_cache(maxsize=2)
def rendered_tiles(title, artist, artwork, font, width, height):
    canvas = card_canvas(title, artist, artwork, font, width, height)
    return {(x, y): png(canvas.crop((x * KEY_SIZE, y * KEY_SIZE, (x+1) * KEY_SIZE, (y+1) * KEY_SIZE)))
            for y in range(height) for x in range(width)}


def card_tiles(title, artist, artwork, font, cards):
    tiles = {}
    for width, height, positions in rectangles(cards):
        images = rendered_tiles(title, artist, artwork, font, width, height)
        for context, x, y in positions:
            tiles[context] = images[x, y]
    return tiles


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
                            return bytes(data)
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


def music_executable(name):
    # The two spellings of the Russian brand use Cyrillic М or Latin M.
    return bool(re.fullmatch(r"(?:яндекс[ ._-]*[мm]узыка|yandex[ ._-]*music)\.exe", name.casefold()))


@lru_cache(maxsize=1)
def automation_client():
    import comtypes.client
    uia = comtypes.client.GetModule(str(Path(os.environ["SystemRoot"]) / "System32" / "UIAutomationCore.dll"))
    automation = comtypes.client.CreateObject("{ff48dba4-60ef-4201-aa87-54103eef594e}", interface=uia.IUIAutomation)
    return automation, uia


VOLUME_NAMES = {"управление громкостью", "громкость", "manage volume", "volume",
                "дауыс деңгейін басқару", "tovush balandligini boshqarish"}


def app_volume_slider():
    import psutil
    from comtypes import COMError

    pids = {proc.pid for proc in psutil.process_iter(["name"]) if music_executable(proc.info["name"] or "")}
    if not pids:
        return None
    automation, uia = automation_client()
    # Native UI Automation IDs for ControlTypeProperty and SliderControlType.
    sliders_only = automation.CreatePropertyCondition(30003, 50015)
    windows = automation.GetRootElement().FindAll(2, automation.CreateTrueCondition())  # TreeScope_Children
    for i in range(windows.Length):
        try:
            window = windows.GetElement(i)
            if window.CurrentProcessId not in pids:
                continue
            sliders = window.FindAll(4, sliders_only)  # TreeScope_Descendants
            for j in range(sliders.Length):
                slider = sliders.GetElement(j)
                if (slider.CurrentName or "").strip().casefold() not in VOLUME_NAMES:
                    continue
                pattern = slider.GetCurrentPattern(10003)  # RangeValuePattern
                if pattern:
                    control = pattern.QueryInterface(uia.IUIAutomationRangeValuePattern)
                    if not control.CurrentIsReadOnly and control.CurrentMaximum > control.CurrentMinimum:
                        return control
        except (COMError, OSError):
            continue
    return None


def adjust_slider(slider, step):
    low, high = slider.CurrentMinimum, slider.CurrentMaximum
    start = slider.CurrentValue
    target = min(high, max(low, start + step * (high - low)))
    slider.SetValue(target)
    for attempt in range(5):
        value = slider.CurrentValue
        if abs(value - target) <= 0.011 * (high - low):
            return round(100 * (value - low) / (high - low))
        if attempt < 4:
            time.sleep(0.05)
    raise PlayerDeclinedCommand("The app slider did not confirm the new level")


def volume(step):
    slider = app_volume_slider()
    if slider is None:
        # Chromium may populate the accessibility tree after the first query.
        time.sleep(0.35)
        slider = app_volume_slider()
    if slider is None:
        raise NoAppVolumeSlider("Open Yandex Music's player window and show its volume slider")
    return {"source": "app", "level": adjust_slider(slider, step)}


async def media_action(manager, action, font, cards=None):
    session = music_session(manager)
    if action == "track":
        if session is None:
            return {}
        media = await session.try_get_media_properties_async()
        if media is None or not media.title:
            return {}
        artwork = await thumbnail(media)
        if cards is None:
            return {"image": png(card_canvas(media.title, media.artist, artwork, font, 1, 1))}
        return {"tiles": card_tiles(media.title, media.artist, artwork, font, cards)}
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
        import psutil
        import comtypes.client
        from winrt.windows.storage.streams import DataReader
        return
    font = Path(os.environ["WINDIR"]) / "Fonts" / "segoeui.ttf"
    for line in sys.stdin:
        request = json.loads(line)
        action = request["action"]
        try:
            if action in ("louder", "quieter"):
                request.update(volume(0.05 if action == "louder" else -0.05))
            else:
                async with asyncio.timeout(6):
                    if manager is None:
                        manager = await Manager.request_async()
                    request.update(await media_action(manager, action, font, request.pop("cards", None)))
        except Exception as exc:
            if isinstance(exc, (OSError, TimeoutError)):
                manager = None
            request["error"] = type(exc).__name__
            print(f"{action}: {exc}", file=sys.stderr)
        print(json.dumps(request), flush=True)


@contextmanager
def windows_apartment():
    # UI Automation and the media session manager share this worker's MTA thread.
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
