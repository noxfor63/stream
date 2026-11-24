"""Exercise the shipped extension in Chromium against a simulated Mirabox host."""
import asyncio
import argparse
import base64
import io
import json
import os
import subprocess
import tempfile
import time
import wave
from pathlib import Path

from aiohttp import web, ClientSession, ClientConnectionError
from PIL import Image, ImageDraw
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'com.noxfor63.streamdock.browsermedia.sdPlugin'
ACTIONS = {entry['UUID'].rsplit('.', 1)[1]: entry['UUID']
           for entry in json.loads((PLUGIN / 'manifest.json').read_text())['Actions']}
COLORS = [(200, 25, 25), (20, 190, 20), (30, 30, 200),
          (210, 170, 20), (180, 20, 160), (20, 180, 200)]


def make_media(directory):
    frames = []
    for brightness in (1, 0.66):
        image = Image.new('RGB', (192, 128))
        draw = ImageDraw.Draw(image)
        for i, rgb in enumerate(COLORS):
            x, y = i % 3 * 64, i // 3 * 64
            draw.rectangle((x, y, x + 63, y + 63), fill=tuple(round(c * brightness) for c in rgb))
        frames.append(image.tobytes())
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24',
                    '-video_size', '192x128', '-framerate', '4', '-i', '-', '-c:v', 'libvpx',
                    '-threads', '1', '-pix_fmt', 'yuv420p', str(directory / 'movie.webm')],
                   input=b''.join(frames[(i // 3) % 2] for i in range(180)), check=True)
    with wave.open(str(directory / 'song.wav'), 'wb') as sound:
        sound.setparams((1, 2, 8000, 0, 'NONE', ''))
        sound.writeframes(bytes(8000 * 2 * 40))


async def wait_until(check, description, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return
        await asyncio.sleep(0.08)
    raise AssertionError('Timeout: ' + description)


async def exercise(directory, emulate_extension=False, benchmark=False, min_fps=0):
    make_media(directory)
    if benchmark:
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'testsrc2=size=432x288:rate=60', '-t', '12', '-c:v', 'libvpx',
                        '-threads', '1', '-deadline', 'realtime', '-b:v', '2M',
                        str(directory / 'motion.webm')], check=True)
    socket = None
    runtime_bus = None
    content_channels = {}
    runtime_ready = asyncio.Event()
    api_requests = {}
    extension_settings = {}

    async def settings_handler(request):
        if request.method == 'POST':
            extension_settings.update(await request.json())
        return web.json_response(extension_settings)

    async def runtime_handler(request):
        nonlocal runtime_bus
        runtime_bus = web.WebSocketResponse()
        await runtime_bus.prepare(request)
        runtime_ready.set()
        async for raw in runtime_bus:
            message = json.loads(raw.data)
            if message.get('type') == 'apiResult':
                future = api_requests.get(message['id'])
                if future is not None and not future.done():
                    future.set_result(message['result'])
                continue
            channel = content_channels.get(message['id'])
            if channel is not None and not channel.closed:
                await channel.send_json(message['message'])
        runtime_ready.clear()
        return runtime_bus

    async def content_handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await runtime_ready.wait()
        key = str(id(ws))
        content_channels[key] = ws
        await runtime_bus.send_json({'type':'connect', 'id':key, 'name':request.query['name'], 'sender': {
            'id':'jfglpkafjfnniknfhmjnhamjnbgbijai', 'tab':{'id':int(request.query['tab'])},
            'frameId':int(request.query['frame']), 'documentId':key}})
        try:
            async for raw in ws:
                await runtime_bus.send_json({'type':'message','id':key,'message':json.loads(raw.data)})
        except (ClientConnectionError, ConnectionResetError):
            pass
        finally:
            content_channels.pop(key, None)
            if runtime_bus is not None and not runtime_bus.closed:
                await runtime_bus.send_json({'type':'disconnect','id':key})
        return ws

    async def extension_handler(request):
        ws = web.WebSocketResponse(max_msg_size=2**22)
        await ws.prepare(request)
        try:
            async with ClientSession() as client:
                async with client.ws_connect('http://127.0.0.1:18765/browser-media',
                            headers={'Origin':'chrome-extension://jfglpkafjfnniknfhmjnhamjnbgbijai'}, max_msg_size=2**22) as peer:
                    async def forward(source, target):
                        async for msg in source:
                            if msg.type == web.WSMsgType.TEXT:
                                await target.send_str(msg.data)
                        await target.close()
                    await asyncio.gather(forward(ws, peer), forward(peer, ws))
        except (ClientConnectionError, ConnectionResetError):
            await ws.close()
        return ws

    async def api_handler(request):
        future = asyncio.get_running_loop().create_future()
        key = str(id(future))
        api_requests[key] = future
        try:
            await runtime_bus.send_json({'type':'api', 'id':key, 'message':await request.json()})
            return web.json_response(await asyncio.wait_for(future, 5))
        finally:
            api_requests.pop(key, None)

    tile_colors = {}
    levels = set()
    images = {}
    alerts = []
    deliveries = []

    async def dock_handler(request):
        nonlocal socket
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        async for raw in socket:
            message = json.loads(raw.data)
            if message['event'] == 'registerPlugin':
                for i in range(6):
                    await socket.send_json({'event': 'willAppear', 'device': 'panel',
                        'action': ACTIONS['player'], 'context': str(i),
                        'payload': {'settings': {'tile': str(i)}}})
            elif message['event'] == 'setImage':
                data = message['payload']['image']
                if data.startswith('data:image/png;base64,'):
                    deliveries.append((time.monotonic(), message['context'], len(raw.data)))
                    with Image.open(io.BytesIO(base64.b64decode(data.split(',')[1]))) as image:
                        i = int(message['context'])
                        rgb = image.convert('RGB').getpixel((image.width // 2, image.height // 2))
                        tile_colors[i] = rgb
                        images[i] = image.copy()
                        if i == 0 and rgb[0] > 90 and rgb[0] > 3 * max(rgb[1:]):
                            levels.add(rgb[0] > 166)
            elif message['event'] == 'showAlert':
                alerts.append(message['context'])
        return socket

    async def fixture(request):
        file = request.match_info['name']
        if file in ('popup.html', 'popup.js'):
            return web.FileResponse(ROOT/'extension'/file)
        if file == 'favicon.ico':
            return web.Response(status=204)
        if file == 'worker.js':
            scripts = [(ROOT/'tests/worker_adapter.js').read_text(), (ROOT/'extension/background.js').read_text()]
            return web.Response(text='\n'.join(scripts), content_type='application/javascript')
        if file == 'render.js':
            return web.FileResponse(ROOT/'extension/render.js')
        if file == 'controller':
            return web.Response(text='<script>new Worker("/worker.js")</script>', content_type='text/html')
        if file in ('movie.webm', 'song.wav', 'motion.webm'):
            return web.FileResponse(directory / file)
        pages = {
            'watch': '<title>Видео для проверки</title><video controls loop src="/movie.webm"></video>',
            'motion': '<title>60 fps benchmark</title><video controls loop src="/motion.webm"></video>',
            'listen': '<title>Аудио</title><audio controls loop src="/song.wav"></audio>',
            'embed': f'<iframe src="http://localhost:{request.url.port}/listen" allow="autoplay"></iframe>',
            'restricted': f'<title>Ограниченные кадры</title><video controls loop src="http://localhost:{request.url.port}/movie.webm"></video>',
            'blank': '<title>Другая вкладка</title>'
        }
        if file not in pages:
            raise web.HTTPNotFound()
        return web.Response(text=pages[file], content_type='text/html')

    app = web.Application()
    app.router.add_get('/', dock_handler)
    app.router.add_post('/api', api_handler)
    app.router.add_get('/settings', settings_handler)
    app.router.add_post('/settings', settings_handler)
    app.router.add_get('/runtime', runtime_handler)
    app.router.add_get('/content', content_handler)
    app.router.add_get('/extension', extension_handler)
    app.router.add_get('/{name}', fixture)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = runner.addresses[0][1]
    origin = f'http://127.0.0.1:{port}'
    plugin = await asyncio.create_subprocess_exec('node', str(PLUGIN / 'index.js'),
        '-port', str(port), '-pluginUUID', 'local-test', '-registerEvent', 'registerPlugin', '-info', '{}')

    async def press(action):
        for event in ('keyDown', 'keyUp'):
            await socket.send_json({'event': event, 'action': ACTIONS[action], 'context': 'control-' + action})

    try:
        async with async_playwright() as pw:
            extension = str(ROOT / 'extension')
            extra = [] if emulate_extension else ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
            ctx = await pw.chromium.launch_persistent_context(str(directory / 'profile'),
                executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'), headless=True,
                args=extra + ['--autoplay-policy=no-user-gesture-required'],
                ignore_default_args=['--disable-extensions'])
            if emulate_extension:
                controller = await ctx.new_page()
                controller.on('console', lambda msg: print('worker:', msg.text, flush=True) if msg.type in ('error', 'warning') else None)
                await controller.goto(origin + '/controller')
                await asyncio.wait_for(runtime_ready.wait(), 5)
                print('Extension APIs supplied by the test adapter; real video and worker rendering', flush=True)
            async def add_content(page, tab_id):
                if emulate_extension:
                    script = 'globalThis.__testEndpoint = ' + json.dumps(origin.replace('http:', 'ws:')) + ';'
                    script += 'globalThis.__testTabId = ' + str(tab_id) + ';'
                    script += (ROOT/'tests/browser_adapter.js').read_text()
                    script += '\n' + (ROOT/'extension/media.js').read_text()
                    await page.add_init_script(script)

            async def open_popup():
                popup = await ctx.new_page()
                if emulate_extension:
                    await popup.add_init_script("""window.chrome = {runtime:{sendMessage: async message =>
                        (await fetch('/api', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})).json()}};""")
                await popup.goto(origin + '/popup.html' if emulate_extension else
                                 'chrome-extension://jfglpkafjfnniknfhmjnhamjnbgbijai/popup.html')
                await popup.locator('#fps').wait_for()
                await popup.wait_for_function("!document.querySelector('#fps').disabled")
                return popup

            video = ctx.pages[0]
            await add_content(video, 1)
            await video.goto(origin + '/watch')
            await video.locator('video').evaluate("v => {v.volume = .6; return v.play()}")
            await wait_until(lambda: len(levels) == 2, 'two distinct live video frames on key 0', timeout=30)
            for i, expected in enumerate(COLORS):
                assert min(max(abs(tile_colors[i][c] - expected[c] * scale) for c in range(3))
                           for scale in (1, .66)) < 25, (i, tile_colors[i])
            print('Live video, both brightness levels and all six tile colors verified', flush=True)

            if benchmark:
                await video.goto(origin + '/motion')
                await video.locator('video').evaluate('v => v.play()')
                await asyncio.sleep(2)
                start = time.monotonic()
                await asyncio.sleep(6)
                end = time.monotonic()
                sample = [(context, size) for stamp, context, size in deliveries if start <= stamp < end]
                rates = [sum(context == str(i) for context, _ in sample) / (end - start) for i in range(6)]
                print(f'60 fps video → six keys: {min(rates):.1f}–{max(rates):.1f} updates/s per key; '
                      f'{sum(size for _, size in sample) / (end - start) / 1024:.0f} KiB/s to simulated Stream Dock', flush=True)
                assert min(rates) >= min_fps, (rates, min_fps)
                popup = await open_popup()
                assert await popup.locator('#fps').input_value() == '30'
                await popup.locator('#fps').select_option('15')
                await video.bring_to_front()
                await asyncio.sleep(.5)
                start = time.monotonic()
                await asyncio.sleep(4)
                end = time.monotonic()
                sample = [(context, size) for stamp, context, size in deliveries if start <= stamp < end]
                rates = [sum(context == str(i) for context, _ in sample) / (end - start) for i in range(6)]
                assert 10 <= min(rates) <= max(rates) <= 16, rates
                if emulate_extension:
                    assert extension_settings['fps'] == 15, extension_settings
                print(f'15 fps setting: {min(rates):.1f}–{max(rates):.1f} updates/s per key; setting saved', flush=True)
                await popup.reload()
                await popup.wait_for_function("document.querySelector('#fps').value === '15'")
                await popup.locator('#fps').select_option('30')
                if emulate_extension:
                    await wait_until(lambda: extension_settings.get('fps') == 30, 'saved 30 fps')
                await popup.close()
                await video.goto(origin + '/watch')
                await video.locator('video').evaluate('v => {v.volume = .6; return v.play()}')
                await asyncio.sleep(.5)

            other = await ctx.new_page()
            await add_content(other, 2)
            await other.goto(origin + '/blank')
            await other.bring_to_front()
            await press('toggle')
            await video.wait_for_function("document.querySelector('video').paused")
            position = await video.locator('video').evaluate('v => v.currentTime')
            await press('forward')
            await video.wait_for_function("p => Math.abs(document.querySelector('video').currentTime - p) < .2", arg=position+10)
            await press('back')
            await video.wait_for_function("p => Math.abs(document.querySelector('video').currentTime - p) < .2", arg=position)
            for name, expected in [('quieter', .55), ('louder', .60)]:
                await press(name)
                await video.wait_for_function("v => Math.abs(document.querySelector('video').volume - v) < .001", arg=expected)
            await press('mute')
            await video.wait_for_function("document.querySelector('video').muted")
            await press('toggle')
            await video.wait_for_function("!document.querySelector('video').paused")
            print('Background play/pause, seek, volume and mute verified', flush=True)

            await other.goto(origin + '/embed')
            sound = other.frame(url=f'http://localhost:{port}/listen')
            await sound.locator('audio').evaluate('a => {a.volume = .8; return a.play()}')
            # Either source can be initially selected. Cycling once must change the target.
            await asyncio.sleep(1.5)
            await press('quieter')
            async def values():
                return (round(await video.locator('video').evaluate('v => v.volume'), 2),
                        round(await sound.locator('audio').evaluate('a => a.volume'), 2))
            for _ in range(50):
                first = await values()
                if first in ((.55, .8), (.6, .75)):
                    break
                await asyncio.sleep(.1)
            assert first in ((.55, .8), (.6, .75)), first
            await press('cycle')
            await asyncio.sleep(.4)
            await press('quieter')
            for _ in range(50):
                if await values() == (.55, .75):
                    break
                await asyncio.sleep(.1)
            assert await values() == (.55, .75), await values()
            print('Selected-player routing across a video tab and cross-origin audio iframe verified', flush=True)
            if emulate_extension:
                popup = await open_popup()
                await popup.wait_for_function("document.querySelector('#player').options.length === 2")
                assert 'установлена' in await popup.locator('#status').inner_text()
                options = await popup.locator('#player option').evaluate_all("all => all.map(o=>({value:o.value, text:o.textContent}))")
                target = next(o['value'] for o in options if 'Видео для проверки' in o['text'])
                await popup.locator('#player').select_option(target)
                await asyncio.sleep(.25)
                await press('quieter')
                await video.wait_for_function("Math.abs(document.querySelector('video').volume - .50) < .001")
                assert round(await sound.locator('audio').evaluate('a => a.volume'), 2) == .75
                await popup.close()
                print('Extension popup status and explicit player selection verified', flush=True)

            # A video without CORS permission must retain controls while returning a card.
            await other.close()
            await video.goto(origin + '/restricted')
            await video.locator('video').evaluate('v => v.play()')
            await wait_until(lambda: all(i in images for i in range(6)), 'restricted player')
            await asyncio.sleep(2)
            def looks_like_video():
                return all(min(max(abs(tile_colors[i][c] - COLORS[i][c] * scale) for c in range(3))
                           for scale in (1, .66)) < 25 for i in range(6))
            assert not looks_like_video(), tile_colors
            await press('toggle')
            await video.wait_for_function("document.querySelector('video').paused")
            assert not alerts, alerts
            print('Cross-origin frame restriction falls back to a card; controls still work', flush=True)

            # Close and restart the actual host process. The same extension must reconnect.
            await socket.close()
            await asyncio.wait_for(plugin.wait(), 3)
            plugin = await asyncio.create_subprocess_exec('node', str(PLUGIN / 'index.js'),
                '-port', str(port), '-pluginUUID', 'restart-test', '-registerEvent', 'registerPlugin', '-info', '{}')
            await asyncio.sleep(4)
            await press('toggle')
            await video.wait_for_function("!document.querySelector('video').paused")
            print('Reconnect after a Stream Dock restart verified', flush=True)
            await ctx.close()
    finally:
        if socket is not None:
            await socket.close()
        try:
            await asyncio.wait_for(plugin.wait(), 3)
        except TimeoutError:
            plugin.kill()
            await plugin.wait()
        await runner.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--emulate-extension', action='store_true', help='Supply runtime APIs in a managed browser that blocks extensions')
    parser.add_argument('--benchmark', action='store_true', help='Measure six-key delivery with a moving 60 fps video')
    parser.add_argument('--min-fps', type=float, default=0, help='Require at least this many updates per second on every key')
    options = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='browser-media-test-') as tmp:
        asyncio.run(exercise(Path(tmp), options.emulate_extension, options.benchmark, options.min_fps))
