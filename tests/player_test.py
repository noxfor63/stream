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


class MixerActions(unittest.TestCase):
    def test_separate_outputs_only_change_music_sessions(self):
        def audio(name):
            mixer = Mock()
            mixer.GetMasterVolume.return_value = 0.99
            return SimpleNamespace(State=1, Process=SimpleNamespace(name=lambda: name), SimpleAudioVolume=mixer)

        def output(*sessions):
            items = [Mock(QueryInterface=Mock(return_value=s)) for s in sessions]
            enumerator = Mock(GetCount=lambda: len(items), GetSession=items.__getitem__)
            return Mock(AudioSessionManager=Mock(GetSessionEnumerator=lambda: enumerator))

        browser, yandex = audio("chrome.exe"), audio("Яндекс Музыка.exe")
        api = SimpleNamespace(
            AudioUtilities=Mock(GetAllDevices=Mock(return_value=[output(browser), output(yandex)])),
            EDataFlow=SimpleNamespace(eRender=SimpleNamespace(value=0)),
            DEVICE_STATE=SimpleNamespace(ACTIVE=SimpleNamespace(value=1)),
            IAudioSessionControl2=object(),
            AudioSession=lambda control: control,
        )
        modules = {"comtypes": SimpleNamespace(COMError=OSError), "pycaw.pycaw": api,
                   "psutil": SimpleNamespace(NoSuchProcess=ProcessLookupError, AccessDenied=PermissionError)}
        with patch.dict(sys.modules, modules):
            player.volume(0.05)
            api.AudioUtilities.GetAllDevices.assert_called_once_with(0, 1)
            yandex.SimpleAudioVolume.SetMasterVolume.assert_called_once_with(1, None)
            yandex.SimpleAudioVolume.GetMasterVolume.return_value = 0.02
            player.volume(-0.05)
        browser.SimpleAudioVolume.SetMasterVolume.assert_not_called()
        yandex.SimpleAudioVolume.SetMasterVolume.assert_called_with(0, None)


if __name__ == "__main__":
    unittest.main()
