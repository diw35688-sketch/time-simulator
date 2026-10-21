"""时间模拟器本地服务：静态文件 + AI 接口转发 + 保存生成的物品。
只监听 127.0.0.1。API Key 由浏览器随请求带来，服务端不落盘、不打印。
用法：python server.py [端口，默认 8765]
"""
import json, re, sys, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
USER_DIR = ROOT / 'objects' / 'user'
BUILTIN_INDEX = ROOT / 'objects' / 'index.json'   # 内置物品清单，贡献新物品就在这里加一条


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        # 生成的物品跑在沙箱 iframe（不透明源）里，加载 ./vendor/three 需要跨源许可
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith('/api/'):
            return
        sys.stderr.write('%s %s\n' % (self.command, self.path))

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if self.path == '/api/objects':
            return self._json(200, {'builtin': list_builtin(), 'user': list_user()})
        return super().do_GET()

    def do_POST(self):
        if self.client_address[0] not in ('127.0.0.1', '::1'):
            return self._json(403, {'error': '只接受本机请求'})
        try:
            req = self._body()
        except Exception:
            return self._json(400, {'error': '请求不是合法 JSON'})
        if self.path == '/api/chat':
            return self.proxy(req, '/chat/completions', 'POST', req.get('body'))
        if self.path == '/api/models':
            return self.proxy(req, '/models', 'GET', None)
        if self.path == '/api/objects':
            return self.save_object(req)
        self._json(404, {'error': 'unknown api'})

    def proxy(self, req, suffix, method, body):
        base = str(req.get('base') or '').strip().rstrip('/')
        if not re.match(r'^https?://[^\s/]+', base):
            return self._json(400, {'error': 'API 地址要以 http:// 或 https:// 开头'})
        headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json'}
        if req.get('key'):
            headers['Authorization'] = 'Bearer ' + str(req['key']).strip()
        data = json.dumps(body).encode() if body is not None else None
        up = urllib.request.Request(base + suffix, data=data, method=method, headers=headers)
        try:
            resp = urllib.request.urlopen(up, timeout=1800)
        except urllib.error.HTTPError as e:
            return self._json(e.code, {'error': e.read().decode('utf8', 'replace')[:2000]})
        except Exception as e:
            return self._json(502, {'error': f'连不上 {base}：{e}'})
        # 逐块转发，流式输出能实时到浏览器
        self.send_response(resp.status)
        self.send_header('Content-Type', resp.headers.get('Content-Type', 'application/json'))
        self.end_headers()
        try:
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器取消了生成
        finally:
            resp.close()

    def save_object(self, req):
        html = str(req.get('html') or '')
        name = str(req.get('name') or '未命名物品').strip()[:40]
        if '<html' not in html.lower() or len(html) > 2_000_000:
            return self._json(400, {'error': '内容不是完整的 HTML 或过大'})
        USER_DIR.mkdir(parents=True, exist_ok=True)
        oid = 'u' + time.strftime('%Y%m%d-%H%M%S')
        (USER_DIR / f'{oid}.html').write_text(html, encoding='utf8')
        index = read_index()
        index[oid] = {'name': name, 'prompt': str(req.get('prompt') or '')[:500], 'model': str(req.get('model') or '')[:80]}
        (USER_DIR / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf8')
        self._json(200, {'id': oid, 'name': name, 'src': f'objects/user/{oid}.html'})


def list_builtin():
    try:
        return json.loads(BUILTIN_INDEX.read_text(encoding='utf8'))
    except Exception as e:
        sys.stderr.write(f'objects/index.json 读取失败：{e}' + chr(10))
        return []


def read_index():
    try:
        return json.loads((USER_DIR / 'index.json').read_text(encoding='utf8'))
    except Exception:
        return {}


def list_user():
    index = read_index()
    out = []
    for f in sorted(USER_DIR.glob('*.html'), reverse=True) if USER_DIR.exists() else []:
        meta = index.get(f.stem, {})
        out.append({'id': f.stem, 'name': meta.get('name', f.stem), 'src': f'objects/user/{f.name}', 'prompt': meta.get('prompt', '')})
    return out


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'Time Simulator: http://127.0.0.1:{port}/')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
