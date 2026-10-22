"""法阵和物品联动的回归测试（鼠标模式，不开摄像头，不需要 server.py）。
python tests/check_mouse.py           用工作目录里的全部文件
python tests/check_mouse.py --fresh   只用 git 跟踪的文件，模拟别人刚 clone 下来的仓库
"""
import asyncio, json, math, sys
from playwright.async_api import async_playwright
from _static import BASE, serve

FRESH = '--fresh' in sys.argv


async def object_frame(pg):
    for _ in range(150):
        for f in pg.frames:
            if 'embed=1' in f.url:
                try:
                    if await f.evaluate('typeof window.getTime === "function"'):
                        return f
                except Exception:
                    pass
        await pg.wait_for_timeout(200)
    raise RuntimeError('物品页面没有加载出 getTime')


async def run(b, query):
    ctx = await b.new_context(viewport={'width': 1280, 'height': 720})
    await serve(ctx, tracked_only=FRESH)
    pg = await ctx.new_page()
    errs, missing = [], []
    pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)[:200]))
    pg.on('console', lambda m: m.type == 'error' and not m.text.startswith('Failed to load resource') and errs.append(m.text[:200]))
    pg.on('response', lambda r: r.status >= 400 and missing.append(r.url.replace(BASE, '')))
    await pg.goto(f'{BASE}/index.html?nocam{query}')
    frame = await object_frame(pg)
    await pg.wait_for_timeout(1000)
    st = lambda: pg.evaluate('window.__timespell()')
    out = {'object': await pg.evaluate("document.getElementById('objFrame').getAttribute('src')"),
           'sandbox': await pg.evaluate("document.getElementById('objFrame').getAttribute('sandbox')"),
           'menu': await pg.evaluate("[...document.querySelectorAll('#stObj option')].map(o => o.textContent)")}
    await pg.mouse.move(150, 150)
    await pg.wait_for_timeout(600)
    await pg.mouse.wheel(0, 300)
    await pg.wait_for_timeout(400)
    out['far_t'] = (await st())['t']
    await pg.mouse.move(640, 432, steps=10)
    await pg.wait_for_timeout(800)
    await pg.mouse.click(640, 432)
    await pg.wait_for_timeout(1200)
    fwd = []
    for _ in range(12):
        await pg.mouse.wheel(0, 100)
        await pg.wait_for_timeout(150)
        fwd.append(round((await st())['tTarget'], 3))
    await pg.wait_for_timeout(600)
    s = await st()
    out['forward'] = fwd
    out['display_follows'] = abs(s['t'] - s['tTarget']) < 1e-3   # 显示的时间平滑地追上目标
    out['dial_ok'] = abs(s['dialAngle'] - s['t'] * math.radians(s['lifeDeg']) / 2) < 1e-6
    out['stage_at_+1'] = await pg.evaluate('window.timespell.stage()')
    back = []
    for _ in range(24):
        await pg.mouse.wheel(0, -100)
        await pg.wait_for_timeout(150)
        back.append(round((await st())['tTarget'], 3))
    out['backward'] = back
    await pg.wait_for_timeout(600)
    s = await st()
    out['stage_at_-1'] = await pg.evaluate('window.timespell.stage()')
    out['object_t_matches'] = abs(await frame.evaluate('getTime()') - s['t']) < 1e-6
    out['fps'] = round(s['fps'])
    out['audio_tracks'] = s['tracks']
    out['not_found'] = sorted(set(missing))
    out['errors'] = errs
    await ctx.close()
    return out


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        res = {'default': await run(b, ''), 'candle': await run(b, '&object=objects/candle.html')}
        await b.close()
    print(json.dumps(res, ensure_ascii=False, indent=1))

asyncio.run(main())
