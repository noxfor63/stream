"""Windows media routing checks with simulated Windows API projections."""
import asyncio
import base64
from contextlib import nullcontext
from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from PIL import Image

sys.path.insert(0, str(next(Path(__file__).resolve().parents[1].glob("*.sdPlugin"))))
import player


def session(source, playing):
    controls = SimpleNamespace(is_pause_enabled=True, is_play_enabled=True)
    return SimpleNamespace(
        source_app_user_model_id=source,
        get_playback_info=lambda: SimpleNamespace(playback_status=4 if playing else 5, controls=controls),
        try_play_async=AsyncMock(return_value=True),
        try_pause_async=AsyncMock(return_value=True),
        try_skip_next_async=AsyncMock(return_value=True),
        try_skip_previous_async=AsyncMock(return_value=True),
    )


class MediaActions(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        api = SimpleNamespace(GlobalSystemMediaTransportControlsSessionPlaybackStatus=SimpleNamespace(PLAYING=4))
        self.modules = patch.dict(sys.modules, {"winrt.windows.media.control": api})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.browser = session("MicrosoftEdge", True)
        self.paused = session("ru.yandex.desktop.music", False)
        self.playing = session("Яндекс Музыка.exe", True)
        self.manager = Mock()
        self.manager.get_sessions.return_value = [self.browser, self.paused, self.playing]

    async def test_commands_use_playing_yandex_session(self):
        for action in ("next", "previous", "toggle"):
            await player.media_action(self.manager, action, None)
        self.playing.try_skip_next_async.assert_awaited_once()
        self.playing.try_skip_previous_async.assert_awaited_once()
        self.playing.try_pause_async.assert_awaited_once()
        self.browser.try_pause_async.assert_not_awaited()
        self.paused.try_play_async.assert_not_awaited()
        self.manager.get_sessions.return_value = [self.browser, self.paused]
        await player.media_action(self.manager, "toggle", None)
        self.paused.try_play_async.assert_awaited_once()

    async def test_broken_thumbnail_still_sends_png_and_processes_next_press(self):
        class BadArtwork:
            @property
            def thumbnail(self):
                raise OSError("Media source lost artwork")
            title = "Название"
            artist = "Исполнитель"

        self.playing.try_get_media_properties_async = AsyncMock(return_value=BadArtwork())
        with patch.dict(sys.modules, {"winrt.windows.storage.streams": SimpleNamespace(DataReader=Mock())}):
            data = await player.media_action(self.manager, "track", "DejaVuSans.ttf")
        header, encoded = data["image"].split(",")
        self.assertEqual(header, "data:image/png;base64")
        with Image.open(BytesIO(base64.b64decode(encoded))) as image:
            self.assertEqual(image.size, (144, 144))
            self.assertEqual(image.format, "PNG")
        await player.media_action(self.manager, "next", None)
        self.playing.try_skip_next_async.assert_awaited_once()

    async def test_windows_art_stream_reaches_key_image(self):
        buffer = BytesIO()
        Image.new("RGB", (300, 180), "#bd550a").save(buffer, format="JPEG")
        raw = buffer.getvalue()
        source = object()
        stream = SimpleNamespace(size=len(raw), get_input_stream_at=Mock(return_value=source))
        ref = SimpleNamespace(open_read_async=AsyncMock(return_value=nullcontext(stream)))
        media = SimpleNamespace(title="Трек", artist="Группа", thumbnail=ref)
        self.playing.try_get_media_properties_async = AsyncMock(return_value=media)

        def read_bytes(data):
            data[:] = raw

        reader = SimpleNamespace(load_async=AsyncMock(return_value=len(raw)), read_bytes=read_bytes)
        factory = Mock(return_value=nullcontext(reader))
        with patch.dict(sys.modules, {"winrt.windows.storage.streams": SimpleNamespace(DataReader=factory)}):
            result = await player.media_action(self.manager, "track", "DejaVuSans.ttf")
        factory.assert_called_once_with(source)
        stream.get_input_stream_at.assert_called_once_with(0)
        with Image.open(BytesIO(base64.b64decode(result["image"].split(",")[1]))) as image:
            self.assertEqual(image.getpixel((40, 40)), Image.open(BytesIO(raw)).getpixel((40, 40)))

    async def test_slow_artwork_is_optional(self):
        async def delayed():
            await asyncio.sleep(30)
        media = SimpleNamespace(thumbnail=SimpleNamespace(open_read_async=delayed))
        with patch.dict(sys.modules, {"winrt.windows.storage.streams": SimpleNamespace(DataReader=Mock())}):
            self.assertIsNone(await asyncio.wait_for(player.thumbnail(media), 4))

    async def test_foreign_session_cannot_receive_commands(self):
        self.manager.get_sessions.return_value = [self.browser]
        self.assertEqual(await player.media_action(self.manager, "track", None), {})
        with self.assertRaisesRegex(RuntimeError, "No matching"):
            await player.media_action(self.manager, "next", None)
        self.browser.try_skip_next_async.assert_not_awaited()


class CoverLayouts(unittest.TestCase):
    def test_four_keys_make_one_canvas_on_the_same_device(self):
        def keys(name, coords):
            return [dict(device=name, row=y, column=x, context=f"{name}:{x},{y}") for x,y in coords]
        block = keys("deck", [(1,2), (2,2), (1,1), (2,1)])
        others = keys("second", [(2,2)]) + keys("deck", [(4,2)])
        art = Image.new("RGB", (288, 288))
        for x, y, color in [(0,0,"red"), (144,0,"green"), (0,144,"blue"), (144,144,"yellow")]:
            art.paste(color, (x, y, x+144, y+144))
        buf = BytesIO()
        art.save(buf, "PNG")
        args = ("Название", "Исполнитель", buf.getvalue(), "DejaVuSans.ttf")
        tiles = player.card_tiles(*args, block + others)
        combined = Image.new("RGB", (288,288))
        for c in block:
            tile = Image.open(BytesIO(base64.b64decode(tiles[c["context"]].split(",")[1])))
            combined.paste(tile, ((c["column"]-1)*144, (c["row"]-1)*144))
        self.assertEqual(combined.tobytes(), player.card_canvas(*args, 2, 2).tobytes())
        self.assertEqual(combined.getpixel((180, 20)), (0,128,0))
        fallback = player.png(player.card_canvas(*args, 1, 1))
        self.assertTrue(all(tiles[c["context"]] == fallback for c in others))

    def test_manual_quadrants_without_host_positions(self):
        cards = [{"context": name, "coverCorner": name} for name in
                 ("bottom-right", "top-left", "bottom-left", "top-right")]
        # Each key must work even when the host reports identical coordinates.
        for card in cards[:2]:
            card.update(device="deck", row=0, column=0)
        art = Image.new("RGB", (288, 288))
        colors = {"top-left":"red", "top-right":"green", "bottom-left":"blue", "bottom-right":"yellow"}
        for name, color in colors.items():
            x = 144 if name.endswith("right") else 0
            y = 144 if name.startswith("bottom") else 0
            art.paste(color, (x, y, x+144, y+144))
        buf = BytesIO()
        art.save(buf, "PNG")
        args = ("Трек", "Исполнитель", buf.getvalue(), "DejaVuSans.ttf")
        images = player.card_tiles(*args, cards)
        combined = Image.new("RGB", (288, 288))
        for name in colors:
            x = 144 if name.endswith("right") else 0
            y = 144 if name.startswith("bottom") else 0
            tile = Image.open(BytesIO(base64.b64decode(images[name].split(",")[1])))
            combined.paste(tile, (x, y))
        self.assertEqual(combined.tobytes(), player.card_canvas(*args, 2, 2).tobytes())

    def test_partial_rectangle_and_missing_coordinates_remain_readable(self):
        cards = [dict(context=str(i), device="a", column=x, row=y)
                 for i, (x,y) in enumerate([(0,0),(0,1),(1,0)])]
        cards.append({"context":"no-position"})
        self.assertEqual([(w,h) for w,h,_ in player.rectangles(cards)], [(1,1)]*4)


class AppVolumeActions(unittest.TestCase):
    def test_app_slider_uses_its_own_scale_and_reports_confirmed_volume(self):
        for maximum in (1, 100):
            slider = SimpleNamespace(CurrentMinimum=0, CurrentMaximum=maximum, CurrentValue=maximum/2)
            slider.SetValue = lambda level: setattr(slider, "CurrentValue", level)
            with patch.object(player, "app_volume_slider", return_value=slider), \
                 patch.dict(sys.modules, {"comtypes": SimpleNamespace(COMError=OSError)}):
                self.assertEqual(player.volume(0.05), {"source": "app", "level": 55})
                self.assertEqual(player.volume(-0.05), {"source": "app", "level": 50})

    def test_find_volume_slider_confines_search_to_music_and_skips_seek(self):
        def collection(*elements):
            return SimpleNamespace(Length=len(elements), GetElement=elements.__getitem__)
        foreign = Mock(CurrentProcessId=99)
        seek = Mock(CurrentName="Позиция воспроизведения")
        volume_slider = Mock(CurrentName="Управление громкостью")
        writeable = SimpleNamespace(CurrentIsReadOnly=False, CurrentMinimum=0, CurrentMaximum=1)
        volume_slider.GetCurrentPattern.return_value.QueryInterface.return_value = writeable
        music = Mock(CurrentProcessId=3, FindAll=Mock(return_value=collection(seek, volume_slider)))
        automation = Mock()
        automation.GetRootElement.return_value.FindAll.return_value = collection(foreign, music)
        processes = [SimpleNamespace(pid=3, info={"name":"Яндекс Музыка.exe"}),
                     SimpleNamespace(pid=99, info={"name":"chrome.exe"})]
        modules = {"psutil": SimpleNamespace(process_iter=lambda _: processes), "comtypes": SimpleNamespace(COMError=OSError)}
        with patch.dict(sys.modules, modules), patch.object(player, "automation_client", return_value=(automation, Mock())):
            self.assertIs(player.app_volume_slider(), writeable)
            foreign.FindAll.assert_not_called()
            seek.GetCurrentPattern.assert_not_called()
            automation.CreatePropertyCondition.assert_called_once_with(30003, 50015)

    def test_unconfirmed_or_inaccessible_slider_reports_failure(self):
        slider = SimpleNamespace(CurrentMinimum=0, CurrentMaximum=1, CurrentValue=0.5, SetValue=Mock())
        with patch.object(player.time, "sleep"), patch.object(player, "app_volume_slider", return_value=slider):
            with self.assertRaises(player.PlayerDeclinedCommand):
                player.volume(-0.05)
        slider.SetValue.assert_called_once()
        with patch.object(player.time, "sleep"), patch.object(player, "app_volume_slider", return_value=None):
            with self.assertRaises(player.NoAppVolumeSlider):
                player.volume(0.05)


if __name__ == "__main__":
    unittest.main()
