"""用 Chrome 的虚拟摄像头测试：摄像头画面能出来，手势和姿态模型能从本地加载。不需要 server.py。"""
import asyncio, json
from playwright.async_api import async_playwright
from _static import BASE, serve


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 1280, 'height': 720})
        await serve(ctx)
        pg = await ctx.new_page()
        errs, missing = [], []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        pg.on('console', lambda m: m.type == 'error' and not m.text.startswith('Failed to load resource') and errs.append(m.text[:200]))
        pg.on('response', lambda r: r.status >= 400 and not r.url.endswith('/api/objects') and missing.append(r.url))   # 没开 server.py 时 api 404 是正常的
        await pg.goto(f'{BASE}/index.html')
        status = ''
        for _ in range(60):
            await pg.wait_for_timeout(1000)
            status = (await pg.evaluate('window.__timespell()'))['handStatus']
            if status.startswith('就绪') or '失败' in status:
                break
        for _ in range(30):   # 姿态模型在手势模型之后加载，软件渲染下要十来秒
            status = (await pg.evaluate('window.__timespell()'))['handStatus']
            if '手臂' in status or not status.startswith('就绪'):
                break
            await pg.wait_for_timeout(1000)
        v = await pg.evaluate("(() => { const v = document.getElementById('cam'); return { w: v.videoWidth, h: v.videoHeight, playing: !v.paused } })()")
        print(json.dumps({'handStatus': status, 'arm_model': '手臂' in status, 'video': v,
                          'banner': await pg.evaluate("document.getElementById('banner').textContent"), 'not_found': missing, 'errors': errs}, ensure_ascii=False, indent=1))
        await b.close()

asyncio.run(main())
