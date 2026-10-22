"""时间物品自动验收，对照 prompts/object_task.md 的验收标准。不需要启动 server.py。
用法：python tests/check_object.py objects/apple3d.html
"""
import asyncio, io, json, sys
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright
from _static import BASE, serve

PATH = sys.argv[1].replace(chr(92), '/').lstrip('./')
W, H = 1280, 720
SCRUB_JS = """async () => {
  const frame = () => new Promise(r => requestAnimationFrame(r)), heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  // 和宿主页面一样用 postMessage 发时间（嵌入模式下的降频补丁靠这个消息知道时间变了）
  const send = t => window.postMessage({ type: 'timespell:setTime', t }, '*');
  for (let i = 0; i < 30; i++) { send(Math.sin(i / 12)); await frame(); }
  const mem0 = heap(), times = []; let last = performance.now();
  for (let i = 0; i < 240; i++) { send(Math.sin(i / 12)); await frame(); const now = performance.now(); times.push(now - last); last = now; }
  const mem1 = heap(); times.sort((a, b) => a - b);
  return { avgMs: +(times.reduce((s, v) => s + v, 0) / times.length).toFixed(1), p95Ms: +times[Math.floor(times.length * .95)].toFixed(1), heapGrowMB: +((mem1 - mem0) / 1e6).toFixed(1) };
}"""


def objdiff(a, b):
    # 只在物品所在的区域（任一帧不透明的像素）里比较，按透明度预乘，避免细长的物品被整屏平均稀释
    mask = (a[..., 3] > 10) | (b[..., 3] > 10)
    if not mask.any():
        return 0.0
    pa, pb = a[..., :3] * (a[..., 3:] / 255), b[..., :3] * (b[..., 3:] / 255)
    return round(float(np.abs(pa - pb)[mask].mean()), 2)


async def check(b, mode):
    ctx = await b.new_context(viewport={'width': W, 'height': H})
    await serve(ctx)
    pg = await ctx.new_page()
    errs, external = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text[:200]))
    pg.on('request', lambda r: not r.url.startswith((BASE, 'data:', 'blob:')) and external.append(r.url[:100]))
    await pg.goto(f'{BASE}/{PATH}{mode}')
    try:
        await pg.wait_for_function('typeof window.setTime === "function"', timeout=20000)
    except Exception:
        await ctx.close()
        return {'FATAL': 'setTime 不存在', 'errors': errs}
    await pg.wait_for_timeout(1500)

    async def shot(t):
        await pg.evaluate(f'window.setTime({t})')
        await pg.wait_for_timeout(350)
        return np.asarray(Image.open(io.BytesIO(await pg.screenshot(omit_background=True))).convert('RGBA')).astype(int)

    a = await shot(0.7); await shot(-0.5); c = await shot(0.7)
    m1, z, p1 = await shot(-1), await shot(0), await shot(1)
    r = {'canvas_count': await pg.evaluate("document.querySelectorAll('canvas').length"), 'errors': errs, 'external_requests': external,
         'fps': round((await pg.evaluate('window.__timeState?.().fps')) or 0),
         'purity_px_changed%': round((np.abs(a - c).max(2) > 2).mean() * 100, 3),
         'diff_-1_vs_0': objdiff(m1, z), 'diff_+1_vs_0': objdiff(p1, z),
         'stages': await pg.evaluate('window.getStages ? window.getStages().map(s => s.t + ":" + s.name) : null')}
    # 拨动时宿主每帧调用一次 setTime：连续扫 120 帧，量每帧耗时和内存增长
    r['scrub'] = await pg.evaluate(SCRUB_JS)
    await pg.evaluate("window.postMessage({ type: 'timespell:setTime', t: 0.33 }, '*')")
    await pg.wait_for_timeout(200)
    r['postMessage_ok'] = abs(await pg.evaluate('window.getTime()') - .33) < 1e-6
    await pg.evaluate('window.setTime(5)')
    r['clamp_ok'] = await pg.evaluate('window.getTime()') == 1
    if mode:
        r['corner_alpha_max'] = int(max(z[:10, :10, 3].max(), z[:10, -10:, 3].max(), z[-10:, :10, 3].max(), z[-10:, -10:, 3].max()))
        r['visible_ui'] = await pg.evaluate("[...document.body.querySelectorAll('*')].filter(e => !['CANVAS','SCRIPT','STYLE'].includes(e.tagName) && e.offsetParent !== null && e.getBoundingClientRect().width > 0).map(e => e.tagName + '#' + e.id).slice(0, 5)")
        ys, xs = np.where(z[..., 3] > 40)
        if len(xs):
            r['t0_center'] = [round((xs.min() + xs.max()) / 2), round((ys.min() + ys.max()) / 2)]
            r['t0_size'] = int(max(xs.max() - xs.min(), ys.max() - ys.min()))
        else:
            r['t0_center'] = None
        r['expected'] = {'center': [W * .5, H * .6], 'size': round(min(W, H) * .35)}
    await ctx.close()
    return r


def verdict(s, e):
    ok = lambda cond: '通过' if cond else '不通过'
    out = {
        '1 无报错': ok(not s.get('errors') and not e.get('errors') and 'FATAL' not in s and 'FATAL' not in e),
        # 嵌入模式下时间不变时会故意少重画（prompts/embed_fix.html），所以帧率只看独立模式；拨动时的流畅度看第 7 条
        '2 帧率≥30（独立模式）': ok(s.get('fps', 0) >= 30),
        '3 纯函数（往回拨逐像素复原）': ok(s.get('purity_px_changed%') == 0 and e.get('purity_px_changed%') == 0),
        '4 嵌入模式透明、无 UI': ok(e.get('corner_alpha_max') == 0 and not e.get('visible_ui') and e.get('t0_center') is not None),
        '5 过去/现在/未来明显不同': ok(min(e.get('diff_-1_vs_0', 0), e.get('diff_+1_vs_0', 0)) > 8),
        '6 无外部请求': ok(not s.get('external_requests') and not e.get('external_requests')),
        '接口 postMessage / 截断': ok(s.get('postMessage_ok') and s.get('clamp_ok')),
        '7 拨动流畅（每帧平均 ≤20ms，内存不涨）': ok(all(x.get('scrub') and x['scrub']['avgMs'] <= 20 and x['scrub']['heapGrowMB'] < 20 for x in (s, e))),
    }
    return out


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
        s, e = await check(b, ''), await check(b, '?embed=1')
        await b.close()
    v = verdict(s, e)
    print(json.dumps({'standalone': s, 'embed': e, 'verdict': v}, ensure_ascii=False, indent=1))
    sys.exit(0 if all(x == '通过' for x in v.values()) else 1)

asyncio.run(main())
