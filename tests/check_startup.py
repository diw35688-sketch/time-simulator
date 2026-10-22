"""冷启动测试：用合成手势视频当摄像头，打开页面后每秒记一次识别状态，看 CPU → GPU → 手臂的切换过程中识别有没有卡住。
加 --twice 会在同一个浏览器里再打开一次（着色器已经编译过、模型已经缓存，相当于用户第二次打开）。
用法：python tests/check_startup.py [秒数，默认 35] [--twice]
"""
import asyncio, json, pathlib, subprocess, sys, tempfile
from playwright.async_api import async_playwright
from _static import BASE, serve

VIDEO = pathlib.Path(tempfile.gettempdir()) / 'timesim-hand' / 'hand.y4m'
SECONDS = next((int(a) for a in sys.argv[1:] if a.isdigit()), 35)
TWICE = '--twice' in sys.argv


async def visit_once(ctx, visit):
    pg = await ctx.new_page()
    await pg.goto(f'{BASE}/index.html')
    rows = []
    for i in range(SECONDS if visit == 1 else min(SECONDS, 15)):
        await pg.wait_for_timeout(1000)
        s = await pg.evaluate('(() => { const s = window.__timespell(); return { status: s.handStatus, rate: s.detector.rate, fps: s.fps, hands: s.hands, gpuMs: s.detector.gpuMs, poseMs: s.detector.poseMs, readyMs: s.detector.readyMs }; })()')
        rows.append(s)
        print(f"第{visit}次 {i + 1:3d}s  {s['status']:<16}  识别 {s['rate']:5.1f}/s  画面 {s['fps']:4.0f}fps  手 {s['hands']}", flush=True)
    await pg.close()
    return rows


def report(rows, visit):
    ready = [i for i, r in enumerate(rows) if r['status'].startswith('就绪')]
    after = rows[ready[0] + 2:] if ready else []
    last = rows[-1]
    print(json.dumps({'第几次打开': visit, 'CPU 就绪 ms': round(last['readyMs'] or 0), 'GPU 接管 ms': round(last['gpuMs'] or 0), '手臂就绪 ms': round(last['poseMs'] or 0),
                      '就绪后识别低于 4 次/秒的秒数': sum(1 for r in after if r['rate'] < 4), '最低画面帧率': round(min((r['fps'] for r in after), default=0))}, ensure_ascii=False))


async def main():
    if not VIDEO.exists():
        subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('make_hand_video.py'))], check=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={VIDEO}', '--use-gl=angle'])
        ctx = await b.new_context(viewport={'width': 1280, 'height': 720})
        await serve(ctx)
        for visit in ([1, 2] if TWICE else [1]):
            rows = await visit_once(ctx, visit)
            report(rows, visit)
        await b.close()

asyncio.run(main())
