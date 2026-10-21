"""server.py 安全与公开模式测试：在随机端口起一个临时服务，测完就关；不会调用需要 Key 的 AI 接口。
python tests/check_server_security.py            本地模式
python tests/check_server_security.py --public   公开模式（创空间），另外用浏览器测物品加载
"""
import json, os, pathlib, shutil, sys, threading, urllib.error, urllib.request

PUBLIC = '--public' in sys.argv
if PUBLIC:
    os.environ['TIMESPELL_PUBLIC'] = '1'
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
from http.server import ThreadingHTTPServer
import tempfile
TMP = pathlib.Path(tempfile.mkdtemp(prefix='timesim-test-'))
server.USER_DIR = TMP / 'user'   # 测试用临时目录，不碰你自己生成的物品

httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
B = 'http://127.0.0.1:' + str(httpd.server_address[1])
checks = {}


def get(path):
    try:
        r = urllib.request.urlopen(B + path, timeout=10)
        r.read()
        return r.status, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers


def post(path, obj, header=True, ip=None):
    h = {'Content-Type': 'application/json'}
    if header:
        h['X-Timespell'] = '1'
    if ip:
        h['X-Forwarded-For'] = ip
    req = urllib.request.Request(B + path, data=json.dumps(obj).encode(), headers=h, method='POST')
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


def check(name, cond):
    checks[name] = 'OK' if cond else 'FAIL'


def http_checks():
    s, h = get('/'); check('首页 200', s == 200)
    check('首页不给跨源许可', h.get('Access-Control-Allow-Origin') is None)
    for p in ['/server.py', '/.gitignore', '/.env', '/tests/check_object.py', '/objects/../.gitignore', '/vendor/%2e%2e/LICENSE', '/vendor/']:
        check('不提供 ' + p, get(p)[0] == 404)
    s, h = get('/vendor/three/three.module.js')
    check('three.js 200 且允许跨源', s == 200 and h.get('Access-Control-Allow-Origin') == '*')
    s, h = get('/objects/candle.html')
    check('物品页带沙箱 CSP', s == 200 and h.get('Content-Security-Policy') == 'sandbox allow-scripts')
    s, h = get('/api/objects')
    check('接口不给跨源许可', s == 200 and h.get('Access-Control-Allow-Origin') is None)
    check('缺自定义头的 POST 被拒', post('/api/models', {'base': 'https://api.deepseek.com'}, header=False)[0] == 403)
    check('非法地址被拒', post('/api/models', {'base': 'ftp://x'})[0] == 400)


def mode_checks():
    if PUBLIC:
        check('公开模式拒绝转发到本机', post('/api/models', {'base': 'http://127.0.0.1:1'})[0] == 400)
        check('公开模式拒绝不在白名单的域名', post('/api/models', {'base': 'https://evil.example.com/v1'})[0] == 400)
        code, _ = post('/api/models', {'base': 'https://api.deepseek.com'})
        check('白名单域名会被转发（上游返回什么都行）', code not in (400, 403))
        code, saved = post('/api/objects', {'name': '测试', 'html': '<!doctype html><html><body>x</body></html>'}, ip='10.9.9.1')
        check('公开模式保存用随机文件名', code == 200 and len(saved.get('id', '')) == 32)
        listed = json.loads(urllib.request.urlopen(B + '/api/objects').read())
        check('公开模式不公开列出别人生成的物品', listed['user'] == [] and listed['public'] is True)
        server.LIMITS['/api/objects'] = 2
        codes = [post('/api/objects', {'name': 'x', 'html': '<html></html>'}, ip='10.9.9.2')[0] for _ in range(3)]
        check('公开模式按 IP 限流', codes == [200, 200, 429])
    else:
        check('本地模式可以转发到本机（比如 Ollama）', post('/api/models', {'base': 'http://127.0.0.1:1'})[0] == 502)
        code, saved = post('/api/objects', {'name': '测试', 'html': '<!doctype html><html><body>x</body></html>'})
        listed = json.loads(urllib.request.urlopen(B + '/api/objects').read())
        check('本地模式保存并列出', code == 200 and any(o['id'] == saved.get('id') for o in listed['user']))


async def browser_checks():
    # 用真实的 server.py（带 CSP 沙箱和跨源头）跑一遍：物品能在沙箱里加载、阶段名能传回来
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1280, 'height': 720})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:160]))
        pg.on('console', lambda m: m.type == 'error' and errs.append(m.text[:160]))
        await pg.goto(B + '/index.html?nocam&object=objects/candle.html')
        ok = False
        for _ in range(100):
            frames = [f for f in pg.frames if 'embed=1' in f.url]
            if frames:
                try:
                    ok = await frames[0].evaluate('typeof window.getTime === "function"')
                except Exception:
                    ok = False
            if ok:
                break
            await pg.wait_for_timeout(200)
        check('浏览器：物品在沙箱里加载出来', ok)
        await pg.mouse.move(640, 432, steps=8)
        await pg.wait_for_timeout(800)
        for _ in range(10):
            await pg.mouse.wheel(0, 100)
            await pg.wait_for_timeout(120)
        await pg.wait_for_timeout(400)
        check('浏览器：阶段名传回宿主页', await pg.evaluate('window.timespell.stage()') != '')
        note = await pg.evaluate("document.getElementById('stKeyNote').textContent")
        check('浏览器：在线版提示' if PUBLIC else '浏览器：本地版提示', ('在线版' in note) == PUBLIC)
        check('浏览器：没有报错', not errs)
        if errs:
            print('errors', errs)
        await b.close()


try:
    http_checks()
    mode_checks()
    if '--browser' in sys.argv or PUBLIC:
        import asyncio
        asyncio.run(browser_checks())
finally:
    httpd.shutdown()
    shutil.rmtree(TMP, ignore_errors=True)
for k, v in checks.items():
    print(v, k)
print('全部通过' if all(v == 'OK' for v in checks.values()) else '有未通过的项目')
sys.exit(0 if all(v == 'OK' for v in checks.values()) else 1)
