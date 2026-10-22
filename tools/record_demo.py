"""录 README 用的演示动图和物品图鉴（鼠标模式，不需要 server.py）。
python tools/record_demo.py   生成 docs/demo.gif 和 docs/objects.jpg（需要 ffmpeg、Pillow、numpy、playwright）
"""
import asyncio, io, pathlib, shutil, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from _static import BASE, serve

W, H = 1280, 720
HIDE = '#hud, #tip, #sound, #stBtn, #stPanel, #camSel, #banner, #caption { display: none !important; }'
CAPTION_JS = """(() => { const d = document.createElement('div'); d.id = 'cap';
  d.style.cssText = 'position:fixed;left:0;right:0;bottom:44px;text-align:center;color:#e6fff0;font:600 34px "Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:.08em;text-shadow:0 0 14px #1dff5e,0 0 3px #000;pointer-events:none';
  document.body.appendChild(d); })()"""
UPDATE_JS = """(() => { const t = window.timespell.stageT(), s = window.timespell.stage();
  document.getElementById('cap').textContent = (t > 0.02 ? '未来 · ' : t < -0.02 ? '过去 · ' : '现在 · ') + s; })()"""
FONTS = ['C:/Windows/Fonts/msyh.ttc', '/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']
BG = (7, 11, 9)


def font(size):
    for f in FONTS:
        if pathlib.Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


async def ready(pg):
    for _ in range(150):
        for f in pg.frames:
            if 'embed=1' in f.url:
                try:
                    if await f.evaluate('typeof window.getTime === "function"'):
                        return
                except Exception:
                    pass
        await pg.wait_for_timeout(200)
    raise RuntimeError('物品没有加载出来')


async def demo_gif(b, out):
    tmp = pathlib.Path(tempfile.mkdtemp())
    ctx = await b.new_context(viewport={'width': W, 'height': H})
    await serve(ctx)
    pg = await ctx.new_page()
    await pg.goto(f'{BASE}/index.html?nocam&object=objects/apple3d.html')
    await ready(pg)
    await pg.wait_for_timeout(1500)
    await pg.add_style_tag(content=HIDE)
    await pg.evaluate(CAPTION_JS)
    n = 0

    async def snap():
        nonlocal n
        await pg.evaluate(UPDATE_JS)
        await pg.screenshot(path=str(tmp / f'{n:04d}.png'))
        n += 1

    for _ in range(4):
        await snap()                                   # 还没召唤法阵
    await pg.mouse.move(880, 320, steps=6)             # 法阵在苹果右上方，不碰到苹果也能隔空拨时间
    for _ in range(10):
        await snap()
    for delta, steps, hold in [(50, 20, 6), (-50, 40, 6), (50, 20, 8)]:   # 拨到未来 → 拨回过去 → 回到现在
        for _ in range(steps):
            await pg.mouse.wheel(0, delta)
            await pg.wait_for_timeout(40)
            await snap()
        for _ in range(hold):
            await snap()
    await ctx.close()
    vf = ('crop=760:540:340:170,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];'
          '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '12', '-i', str(tmp / '%04d.png'), '-vf', vf, '-loop', '0', str(out)], check=True)
    shutil.rmtree(tmp)
    return n


async def gallery(b, out, items):
    rows = []
    for src in items:
        ctx = await b.new_context(viewport={'width': W, 'height': H})
        await serve(ctx)
        pg = await ctx.new_page()
        await pg.goto(f'{BASE}/{src}?embed=1')
        await pg.wait_for_function('typeof window.setTime === "function"')
        await pg.wait_for_timeout(1500)
        stages = await pg.evaluate('window.getStages ? window.getStages() : []')
        shots = []
        for t in (-1, 0, 1):
            await pg.evaluate(f'window.setTime({t})')
            await pg.wait_for_timeout(300)
            im = Image.open(io.BytesIO(await pg.screenshot(omit_background=True))).convert('RGBA')
            shots.append((im, min(stages, key=lambda s: abs(s['t'] - t))['name'] if stages else ''))
        await ctx.close()
        rows.append(shots)
    # 每行放两个物品，每个物品三格：过去、现在、未来
    tile, label_h, head_h, gap, per_row = 200, 40, 50, 24, 2
    rows_n = (len(rows) + per_row - 1) // per_row
    width = per_row * 3 * tile + (per_row - 1) * gap
    sheet = Image.new('RGB', (width, head_h + rows_n * (tile + label_h)), BG)
    d = ImageDraw.Draw(sheet)
    for g in range(per_row):
        for i, lab in enumerate(['过去', '现在', '未来']):
            d.text((g * (3 * tile + gap) + i * tile + tile // 2, head_h // 2), lab, font=font(22), fill=(150, 255, 190), anchor='mm')
    for r, shots in enumerate(rows):
        alpha = np.stack([np.asarray(im)[..., 3] for im, _ in shots]).max(0)
        ys, xs = np.where(alpha > 10)
        side = int(max(xs.max() - xs.min(), ys.max() - ys.min()) * 1.12)
        cx, cy = (xs.min() + xs.max()) // 2, (ys.min() + ys.max()) // 2
        box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
        x0, y = (r % per_row) * (3 * tile + gap), head_h + (r // per_row) * (tile + label_h)
        for c, (im, name) in enumerate(shots):
            cell = Image.new('RGBA', (side, side), BG + (255,))
            cell.alpha_composite(im.crop(box))
            sheet.paste(cell.convert('RGB').resize((tile, tile), Image.LANCZOS), (x0 + c * tile, y))
            d.text((x0 + c * tile + tile // 2, y + tile + label_h // 2), name.split(' · ')[0][:9], font=font(17), fill=(215, 255, 225), anchor='mm')
    sheet.save(out, quality=90)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
        frames = await demo_gif(b, ROOT / 'docs' / 'demo.gif')
        await gallery(b, ROOT / 'docs' / 'objects.jpg', [f'objects/{n}.html' for n in ('apple3d', 'candle', 'rose', 'ice', 'tree', 'snowman', 'coffee')])
        await b.close()
    for f in ['demo.gif', 'objects.jpg']:
        print(f, round((ROOT / 'docs' / f).stat().st_size / 1e6, 2), 'MB')
    print('gif frames', frames)

asyncio.run(main())
