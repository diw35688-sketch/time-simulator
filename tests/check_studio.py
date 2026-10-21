"""设置面板端到端测试（会真的调用 AI 接口）。需要先运行 python server.py，并配置 .env。
用法：python tests/check_studio.py [--generate "物品描述"]
"""
import asyncio, json, pathlib, sys
from playwright.async_api import async_playwright

import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tools'))
import aiconf
conf = aiconf.require(aiconf.load(), 'base', 'key', 'model')   # 见 .env.example
GEN = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == '--generate' else None
GEN_MODEL = conf['model']

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1280, 'height': 720})
        errs = []
        pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)[:200]))
        pg.on('console', lambda m: m.type == 'error' and errs.append(m.text[:200]))
        await pg.goto('http://127.0.0.1:8765/?nocam')
        await pg.wait_for_selector('#stBtn')
        await pg.wait_for_timeout(1500)
        out = {'default_object': await pg.evaluate("document.getElementById('objFrame')?.getAttribute('src')"),
               'options': await pg.evaluate("[...document.querySelectorAll('#stObj option')].map(o=>o.textContent)")}
        await pg.click('#stBtn')
        await pg.fill('#stBase', conf['base'])
        await pg.fill('#stKey', 'sk-wrong-key')
        await pg.fill('#stModel', GEN_MODEL)
        # 在面板里按 M、滚轮，不应触发静音、不应拨时间
        await pg.click('#stDesc'); await pg.keyboard.type('mbd')
        await pg.mouse.move(150, 300); await pg.mouse.wheel(0, 500)
        out['keys_leaked'] = await pg.evaluate("document.getElementById('sound').textContent !== '点击任意处开启声音' && document.getElementById('sound').textContent.includes('静音 · M 恢复')")
        await pg.click('#stTest')
        await pg.wait_for_function("document.getElementById('stApiStatus').className.match(/ok|err/)", timeout=60000)
        out['wrong_key'] = await pg.evaluate("[document.getElementById('stApiStatus').className, document.getElementById('stApiStatus').textContent.slice(0,120)]")
        await pg.fill('#stKey', conf['key'])
        await pg.click('#stTest')
        await pg.wait_for_timeout(300)
        await pg.wait_for_function("document.getElementById('stApiStatus').className.match(/ok|err/) && !document.getElementById('stApiStatus').textContent.includes('正在验证')", timeout=90000)
        out['right_key'] = await pg.evaluate("[document.getElementById('stApiStatus').className, document.getElementById('stApiStatus').textContent.slice(0,120)]")
        out['saved_has_key'] = await pg.evaluate("JSON.parse(localStorage.getItem('timespell.ai')||'{}').key?.length > 10")
        if GEN:
            await pg.fill('#stDesc', '')
            await pg.fill('#stDesc', GEN)
            await pg.click('#stGen')
            await pg.wait_for_function("document.getElementById('stGenStatus').className.match(/ok|err/) || document.getElementById('stGenStatus').textContent.startsWith('完成')", timeout=900000, polling=2000)
            out['gen'] = await pg.evaluate("[document.getElementById('stGenStatus').className, document.getElementById('stGenStatus').textContent]")
            out['frame'] = await pg.evaluate("[document.getElementById('objFrame').getAttribute('src'), document.getElementById('objFrame').getAttribute('sandbox')]")
            await pg.wait_for_timeout(4000)
            out['stage_hud'] = await pg.evaluate("document.getElementById('hud').innerText.split('\\n')[1]")
        out['errors'] = errs
        print(json.dumps(out, ensure_ascii=False, indent=1))
        await b.close()

asyncio.run(main())
