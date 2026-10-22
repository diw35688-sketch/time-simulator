"""线上测试：打开魔搭创空间页面，用合成的手势视频（tests/make_hand_video.py）当摄像头，
测创空间里的后台识别、画面流畅度和拨时间是否准确。
用法：python tests/check_live.py [创空间地址]
"""
import asyncio, subprocess, sys, pathlib
from playwright.async_api import async_playwright
from check_handvideo import VIDEO, analyze, report

URL = sys.argv[1] if len(sys.argv) > 1 else 'https://www.modelscope.cn/studios/c8iolab/time-simulator'


async def app_frame(pg):
    for _ in range(240):
        for f in pg.frames:
            try:
                if await f.evaluate('typeof window.__timespell === "function"'):
                    return f
            except Exception:
                pass
        await pg.wait_for_timeout(500)
    raise RuntimeError('页面里没有找到时间模拟器')


async def main():
    if not VIDEO.exists():
        subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('make_hand_video.py'))], check=True)
    async with async_playwright() as p:
        # 魔搭在国内直连更稳，走本机代理反而握手失败；网关会拦旧版无头浏览器，要用新版无头模式（channel='chromium'）
        b = await p.chromium.launch(channel='chromium', args=['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                          f'--use-file-for-fake-video-capture={VIDEO}', '--use-gl=angle'])
        pg = await (await b.new_context(viewport={'width': 1400, 'height': 900})).new_page()
        errs, logs = [], []
        pg.on('console', lambda m: 'ms.show' in (m.location or {}).get('url', '') and logs.append(m.type + ': ' + m.text[:200]))
        pg.on('console', lambda m: m.type == 'error' and 'ms.show' in (m.location or {}).get('url', '') and not m.text.startswith('INFO:') and errs.append(m.text[:160]))
        await pg.goto(URL, wait_until='domcontentloaded', timeout=90000)
        f = await app_frame(pg)
        try:
            await f.wait_for_function("window.__timespell().handStatus.startsWith('就绪')", timeout=120000)
        except Exception:
            print('两分钟还没就绪：', await f.evaluate('JSON.stringify([window.__timespell().handStatus, window.__timespell().detector, window.__timespell().camOk])'))
            print(chr(10).join(logs[-25:]))
            raise
        try:
            await f.wait_for_function("window.__timespell().handStatus.includes('手臂')", timeout=60000)
        except Exception:
            print('60 秒内 GPU 和手臂识别没有都就绪，按当前状态测')
        print('启动用时：', await f.evaluate("JSON.stringify((({ readyMs, gpuMs, poseMs }) => ({ CPU: Math.round(readyMs), GPU: Math.round(gpuMs), 手臂: Math.round(poseMs) }))(window.__timespell().detector))"))
        # 视频里有 2.5 秒没有手，连续 1.2 秒看不到手才算到了这段空档，避免识别中途丢一下手就误对齐
        await f.wait_for_function("""(() => { const w = window; if (w.__timespell().hands > 0) { w.__noHand = 0; return false; }
          w.__noHand = w.__noHand || performance.now(); return performance.now() - w.__noHand > 1200; })()""", timeout=60000, polling=50)
        await f.wait_for_function('window.__timespell().hands >= 1', timeout=30000, polling=20)
        await f.evaluate('window.__setTime(0); window.__timespellTest.resetPerf(); window.__timespellTest.record()')
        await pg.wait_for_timeout(13200)
        rows = await f.evaluate('window.__timespellTest.stop()')
        pathlib.Path(__import__('tempfile').gettempdir(), 'timesim-rows-live.json').write_text(__import__('json').dumps(rows), encoding='utf8')
        perf = await f.evaluate('window.__timespellTest.perf()')
        st = await f.evaluate('window.__timespell()')
        print('应用地址：', f.url[:80], '| 视口', await f.evaluate('[innerWidth, innerHeight]'))
        await b.close()
    report([analyze('魔搭创空间（线上）', rows, perf, st, errs)])

asyncio.run(main())
