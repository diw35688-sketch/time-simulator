"""自动修复测试：把蜡烛的一行改坏，看设置面板能否定位语法错误并让模型修好（会真的调用 AI 接口）。
需要先运行 python server.py，并配置 .env。
"""
import asyncio, json, pathlib
from playwright.async_api import async_playwright
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tools'))
import aiconf
conf = aiconf.require(aiconf.load(), 'base', 'key', 'model')   # 见 .env.example
good = (pathlib.Path(__file__).resolve().parents[1] / 'objects' / 'candle.html').read_text(encoding='utf8')
bad = good.replace('new THREE.PointLight(0xffa040, ', 'new THREE.PointLight(0xffa martian, ')
assert bad != good
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page()
        await pg.goto('http://127.0.0.1:8765/?nocam')
        await pg.evaluate("([b,k,m]) => localStorage.setItem('timespell.ai', JSON.stringify({base:b, key:k, model:m, maxTokens:64000}))", [conf['base'], conf['key'], conf['model']])
        await pg.reload(); await pg.wait_for_function('window.__studioTest')
        print('good file error:', await pg.evaluate('h => window.__studioTest.syntaxError(h)', good))
        err = await pg.evaluate('h => window.__studioTest.syntaxError(h)', bad)
        print('bad file error: line', err['line'], err['msg'])
        fixed = await pg.evaluate('h => window.__studioTest.repairOnce(h)', bad)
        print('after repair error:', await pg.evaluate('h => window.__studioTest.syntaxError(h)', fixed))
        line = [l.strip() for l in fixed.split('\n') if 'PointLight(' in l]
        print('repaired line:', line[:2])
        await b.close()
asyncio.run(main())
