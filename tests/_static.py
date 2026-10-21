"""测试用的静态文件服务：Playwright 拦截请求直接读项目里的文件，不需要启动 server.py。
tracked_only=True 时只提供 git 跟踪的文件，模拟别人刚 clone 下来的仓库。/api/* 一律 404，相当于纯静态托管。
"""
import pathlib, subprocess, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8765'
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
         '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.css': 'text/css'}
# 物品跑在沙箱 iframe（不透明源）里，加载 three.js 和贴图需要跨源许可，和 server.py 一致
CORS = {'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'}


def tracked_files():
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True).stdout.decode('utf8')
    return {p for p in out.split('\0') if p}


async def serve(context, tracked_only=False):
    allow = tracked_files() if tracked_only else None

    async def handle(route):
        path = urllib.parse.unquote(urllib.parse.urlsplit(route.request.url).path).lstrip('/') or 'index.html'
        f = (ROOT / path).resolve()
        ok = not path.startswith('api/') and f.is_file() and ROOT in f.parents and (allow is None or path in allow)
        if not ok:
            return await route.fulfill(status=404, body='not found', headers=CORS)
        await route.fulfill(status=200, body=f.read_bytes(), headers={**CORS, 'Content-Type': TYPES.get(f.suffix, 'application/octet-stream')})

    await context.route(BASE + '/**', handle)
