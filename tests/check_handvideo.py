"""真实识别测试：用合成的手势视频（tests/make_hand_video.py）当虚拟摄像头，跑真的 MediaPipe，
对比三种识别方式的流畅度、识别速度，以及拨时间是否准确。不需要启动 server.py。
用法：python tests/check_handvideo.py [配置名 ...]，配置名：auto cpu main
"""
import asyncio, json, pathlib, statistics, subprocess, sys, tempfile
from playwright.async_api import async_playwright
from _static import BASE, serve

VIDEO = pathlib.Path(tempfile.gettempdir()) / 'timesim-hand' / 'hand.y4m'
CONFIGS = {'auto': ('后台线程，CPU 先用、GPU 好了切换', ''), 'cpu': ('后台线程，只用 CPU', '?delegate=cpu'), 'main': ('主线程（旧方式）', '?detector=main')}
# 录制时间 r（ms）≈ 视频时间 - 2000（从手出现开始录）
OBJ = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--object=')), None)   # 换一个物品测
WINDOWS = {'still': (300, 1500), 'lockA': (300, 1500), 'lockO': (3500, 3950), 'after60': (6400, 6950), 'back': (9400, 9950), 'after30': (12400, 12950)}


async def run(p, key):
    name, query = CONFIGS[key]
    b = await p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                      f'--use-file-for-fake-video-capture={VIDEO}', '--use-gl=angle', '--autoplay-policy=no-user-gesture-required'])
    ctx = await b.new_context(viewport={'width': 1280, 'height': 720})
    await serve(ctx)
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:160]))
    await pg.goto(f'{BASE}/index.html{query}' + (('&' if query else '?') + 'object=' + OBJ if OBJ else ''))
    await pg.wait_for_function("window.__timespell && window.__timespell().handStatus.startsWith('就绪')", timeout=90000)
    # 自动模式要等 GPU 和手臂识别都预热好（第一次打开要二三十秒），再对齐到视频里“手出现”的那一刻
    if key == 'auto':
        await pg.wait_for_function("window.__timespell().handStatus.includes('手臂')", timeout=90000)
    await pg.wait_for_timeout(3000)
    # 视频里有 2.5 秒没有手，连续 1.2 秒看不到手才算到了这段空档，避免识别中途丢一下手就误对齐
    await pg.wait_for_function("""(() => { const w = window; if (w.__timespell().hands > 0) { w.__noHand = 0; return false; }
      w.__noHand = w.__noHand || performance.now(); return performance.now() - w.__noHand > 1200; })()""", timeout=60000, polling=50)
    await pg.wait_for_function('window.__timespell().hands >= 1', timeout=30000, polling=20)
    got0 = await pg.evaluate('window.__timespell().detector.got')
    await pg.evaluate('window.__setTime(0); window.__timespellTest.resetPerf(); window.__timespellTest.record()')
    await pg.wait_for_timeout(13200)
    rows = await pg.evaluate('window.__timespellTest.stop()')
    pathlib.Path(tempfile.gettempdir(), f'timesim-rows-{key}.json').write_text(json.dumps(rows), encoding='utf8')
    perf = await pg.evaluate('window.__timespellTest.perf()')
    st = await pg.evaluate('window.__timespell()')
    st['avgRate'] = (st['detector']['got'] - got0) / 13.2 if st['detector']['mode'] == 'worker' else None
    await b.close()
    return analyze(name, rows, perf, st, errs)


def analyze(name, rows, perf, st, errs):
    win = lambda k: [f for f in rows if WINDOWS[k][0] <= f['r'] < WINDOWS[k][1]]
    still = [f['rigs'][0] for f in win('still')]
    mx, my = statistics.mean(p['x'] for p in still), statistics.mean(p['y'] for p in still)
    tmean = lambda k: statistics.mean(f['t'] for f in win(k))
    return {
        'name': name, 'status': st['handStatus'], 'rate': st.get('avgRate') or st['detector']['rate'], 'cost': st['detector']['cost'], 'latency': st['detector']['latency'],
        'p50': perf['p50'], 'p95': perf['p95'], 'p99': perf['p99'], 'over25': perf['over25'], 'frames': perf['n'], 'longTasks': perf['longTasks'],
        'jitter': (statistics.mean((p['x'] - mx) ** 2 + (p['y'] - my) ** 2 for p in still)) ** .5,
        'lockA': any(f['rigs'][0]['locked'] for f in win('lockA')), 'lockO': all(f['rigs'][0]['locked'] for f in win('lockO')),
        'after60': tmean('after60'), 'back': tmean('back'), 'after30': tmean('after30'),
        'ghost': max(min(f['rigs'][0]['presence'], f['rigs'][1]['presence']) for f in rows), 'errors': errs,
    }


async def main():
    if not VIDEO.exists():
        subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('make_hand_video.py'))], check=True)
    keys = [k for k in sys.argv[1:] if k in CONFIGS] or list(CONFIGS)
    async with async_playwright() as p:
        res = [await run(p, k) for k in keys]
    report(res)


def report(res):
    rowsdef = [('status', '识别状态', str), ('rate', '识别次数/秒（全程平均）', '{:.1f}'), ('cost', '单帧识别耗时 ms', '{:.0f}'), ('latency', '采集到结果的延迟 ms', '{:.0f}'),
               ('p50', '画面帧间隔中位数 ms', '{:.1f}'), ('p95', '帧间隔 95% 分位 ms', '{:.1f}'), ('p99', '帧间隔 99% 分位 ms', '{:.1f}'),
               ('over25', '超过 25ms 的卡顿帧', '{}'), ('longTasks', '主线程长任务（>50ms）', '{}'), ('jitter', '手静止时法阵抖动 px', '{:.2f}'),
               ('lockA', '离物品远也能控制', '{}'), ('lockO', '手在物品上时一直锁定', '{}'),
               ('after60', '顺时针 60° 后时间（应≈0.79）', '{:.3f}'), ('back', '转回后时间（应≈0）', '{:.3f}'), ('after30', '再转 30° 后（应≈0.39）', '{:.3f}'),
               ('ghost', '重影法阵亮度', '{:.2f}'), ('errors', '页面报错', '{}')]
    for key, label, fmt in rowsdef:
        cells = [(fmt(r[key]) if callable(fmt) else fmt.format(r[key])) for r in res]
        print(label.ljust(22, '　'), ' | '.join(c.ljust(18) for c in cells))
    print(json.dumps([r['name'] for r in res], ensure_ascii=False))

if __name__ == '__main__':
    asyncio.run(main())
