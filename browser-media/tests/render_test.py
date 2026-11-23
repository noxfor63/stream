"""Exercise the shipped renderer inside a browser Worker with OffscreenCanvas."""

import base64
import os
from io import BytesIO
from pathlib import Path
import shutil
import unittest

from PIL import Image
from playwright.sync_api import sync_playwright


def decode_image(uri):
    prefix, encoded = uri.split(",", 1)
    if prefix != "data:image/png;base64":
        raise AssertionError(f"Unexpected image URI {prefix}")
    with Image.open(BytesIO(base64.b64decode(encoded, validate=True))) as image:
        if image.format != "PNG":
            raise AssertionError("Expected a PNG")
        return image.convert("RGB")


class WorkerRendering(unittest.TestCase):
    def test_six_positions_and_small_card(self):
        source = (Path(__file__).resolve().parents[1] / "extension" / "render.js").read_text()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM") or shutil.which("chromium"), headless=True)
            page = browser.new_page()
            frames, idle, live, video, wide = page.evaluate("""async source => {
                const task = source + ";onmessage = async () => {try {postMessage(await test());} catch(e) {postMessage({error:e.message});}};";
                const test = async function test() {
                    const art = new OffscreenCanvas(432, 288);
                    const ctx = art.getContext('2d');
                    const colors = ['red','lime','blue','yellow','cyan','magenta'];
                    colors.forEach((color, i) => {
                        ctx.fillStyle = color;
                        ctx.fillRect((i % 3) * 144, Math.floor(i / 3) * 144, 144, 144);
                    });
                    const wide = new OffscreenCanvas(192, 108);
                    const w = wide.getContext('2d');
                    w.fillStyle = 'orange';
                    w.fillRect(0, 0, 192, 108);
                    const state = {title: 'Длинное название 🎵 '.repeat(12), artist: 'Исполнитель',
                        source: 'example.org', paused: false, position: 53, duration: 220};
                    return [await renderPlayer(state, art), await renderPlayer(null),
                        await renderPlayer({...state, live:true, duration: null}, null),
                        await renderPlayer(state, null, art), await renderPlayer(state, null, wide)];
                };
                const url = URL.createObjectURL(new Blob([task, test.toString()], {type:'application/javascript'}));
                const worker = new Worker(url);
                try {
                    const result = await new Promise((resolve,reject) => {
                        worker.onmessage = e => e.data.error ? reject(Error(e.data.error)) : resolve(e.data);
                        worker.onerror = reject;
                        worker.postMessage(1);
                    });
                    return result;
                } finally {
                    worker.terminate();
                    URL.revokeObjectURL(url);
                }
            }""", source)
            browser.close()
        for page in (frames, idle, live, video, wide):
            self.assertEqual(len(page["tiles"]), 6)
            for uri in [*page["tiles"], page["single"]]:
                self.assertEqual(decode_image(uri).size, (144, 144))
        expected_colors = [(255,0,0),(0,255,0),(0,0,255),(255,255,0),(0,255,255),(255,0,255)]
        for tile, color in zip(video["tiles"], expected_colors):
            image = decode_image(tile)
            self.assertEqual(image.getpixel((10,10)), color)
            self.assertEqual(image.getpixel((130,130)), color)
        # 16:9 video is letterboxed in the 3:2 key block without cutting its sides.
        self.assertEqual(decode_image(wide["tiles"][0]).getpixel((72,5)), (0,0,0))
        self.assertEqual(decode_image(wide["tiles"][0]).getpixel((72,25)), (255,165,0))
        self.assertEqual(decode_image(wide["tiles"][3]).getpixel((72,140)), (0,0,0))
        assembled = Image.new("RGB",(432,288))
        for i,tile in enumerate(video["tiles"]):
            assembled.paste(decode_image(tile),(i%3*144,i//3*144))
        assembled.save("/tmp/browser-media-video.png")
        expected_channels = [(1,0,0),(0,1,0),(0,0,1),(1,1,0),(0,1,1),(1,0,1)]
        for uri, expected in zip(frames["tiles"], expected_channels):
            rgb = decode_image(uri).getpixel((100, 8 if expected in expected_channels[3:] else 70))
            self.assertEqual(tuple(int(c > 30) for c in rgb), expected)
        # The progress bar spans all three columns and is filled according to the supplied time.
        image = decode_image(frames["tiles"][3])
        self.assertEqual(image.getpixel((30, 91)), (105, 224, 194))
        self.assertEqual(image.getpixel((131, 91)), (87, 97, 110))
        self.assertNotEqual(frames["single"], live["single"])
        self.assertNotEqual(live["single"], idle["single"])


if __name__ == "__main__":
    unittest.main()
