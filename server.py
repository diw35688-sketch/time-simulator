"""时间模拟器服务：静态文件 + AI 接口转发 + 保存生成的物品。

本地模式（默认）：只监听 127.0.0.1:8765，可以转发到任何地址（包括本机的 Ollama 之类）。
公开模式（TIMESPELL_PUBLIC=1，部署到魔搭创空间等）：监听 0.0.0.0:7860，只转发到白名单里的 AI 服务，
按 IP 限流、限制同时生成的数量；生成的物品用随机文件名保存，7 天后清理，不出现在公共列表里。
API Key 由浏览器随请求带来，服务端不落盘、不打印。
用法：python server.py [端口]
"""
import collections, json, os, sys, threading, time, urllib.error, urllib.parse, urllib.request, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
USER_DIR = ROOT / 'objects' / 'user'
BUILTIN_INDEX = ROOT / 'objects' / 'index.json'   # 内置物品清单，贡献新物品就在这里加一条
PUBLIC = os.environ.get('TIMESPELL_PUBLIC') == '1'
# 只对外提供这些文件和目录，其它文件（.env、.git 等）一律 404
STATIC_FILES = ('index.html', 'studio.js')
STATIC_DIRS = ('js/', 'objects/', 'prompts/', 'assets/', 'vendor/', 'docs/')
# 物品跑在沙箱 iframe（不透明源）里，加载 three.js 和贴图要跨源许可；接口响应不给，别的网站读不到
CORS_DIRS = ('vendor/', 'assets/', 'objects/')
DEFAULT_HOSTS = ('api.deepseek.com', 'api-inference.modelscope.cn', 'dashscope.aliyuncs.com', 'api.siliconflow.cn',
                 'openrouter.ai', 'api.openai.com', 'api.moonshot.cn', 'open.bigmodel.cn', 'ark.cn-beijing.volces.com', 'tokendance.space')
ALLOWED_HOSTS = tuple(h.strip().lower() for h in os.environ.get('TIMESPELL_ALLOWED_HOSTS', ','.join(DEFAULT_HOSTS)).split(',') if h.strip())
LIMITS = {'/api/chat': 20, '/api/models': 60, '/api/objects': 20}   # 公开模式：每个 IP 每小时的次数，全站上限是它的 20 倍
MAX_BODY = 2_500_000
KEEP_DAYS, MAX_USER_FILES = 7, 500
_hits = collections.defaultdict(collections.deque)
_lock = threading.Lock()
_busy = threading.BoundedSemaphore(int(os.environ.get('TIMESPELL_MAX_GENERATIONS', '3')))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None   # 公开模式不跟随跳转，防止被白名单里的地址跳到内网


_opener = urllib.request.build_opener(_NoRedirect) if PUBLIC else urllib.request.build_opener()


def rel_path(raw):
    return urllib.parse.unquote(urllib.parse.urlsplit(raw).path).lstrip('/')


def is_public_file(rel):
    if rel == '':
        return True
    if any(part.startswith('.') for part in rel.split('/')):
        return False
    return rel in STATIC_FILES or rel.startswith(STATIC_DIRS)


class Handler(SimpleHTTPRequestHandler):
    # 不依赖系统注册表猜类型：Windows 上 .js 有时被登记成 text/plain，浏览器会拒绝加载模块脚本
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wasm': 'application/wasm', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        rel = rel_path(self.path)
        if rel.startswith(CORS_DIRS):
            self.send_header('Access-Control-Allow-Origin', '*')
        if rel.startswith('objects/') and rel.endswith('.html'):
            # 物品是 AI 生成或别人贡献的代码：就算被单独打开，也跑在沙箱里，读不到本站的存储
            self.send_header('Content-Security-Policy', 'sandbox allow-scripts')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):
        if self.path.startswith('/api/'):
            sys.stderr.write(' '.join([self.client_ip(), self.command, self.path.split('?')[0]]) + chr(10))

    def client_ip(self):
        # 创空间这类平台前面有一层代理，真实 IP 在 X-Forwarded-For 的第一个
        fwd = self.headers.get('X-Forwarded-For', '') if PUBLIC else ''
        return fwd.split(',')[0].strip() or self.client_address[0]

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        rel = rel_path(self.path)
        if rel == 'api/objects':
            return self._json(200, {'builtin': list_builtin(), 'user': [] if PUBLIC else list_user(), 'public': PUBLIC})
        if rel == 'api/health':
            return self._json(200, {'ok': True, 'public': PUBLIC})
        if not is_public_file(rel):
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if not is_public_file(rel_path(self.path)):
            return self.send_error(404)
        return super().do_HEAD()

    def rate_ok(self, path):
        limit = LIMITS.get(path)
        if not limit:
            return True
        now = time.time()
        with _lock:
            if len(_hits) > 5000:
                for k in [k for k, q in _hits.items() if not q or now - q[-1] > 3600]:
                    del _hits[k]
            mine, total = _hits[(self.client_ip(), path)], _hits[('*', path)]
            for q in (mine, total):
                while q and now - q[0] > 3600:
                    q.popleft()
            if len(mine) >= limit or len(total) >= limit * 20:
                return False
            mine.append(now)
            total.append(now)
        return True

    def do_POST(self):
        path = '/' + rel_path(self.path)
        # 必须带自定义请求头：别的网站跨域发这种请求，浏览器会先预检，本服务不放行
        if self.headers.get('X-Timespell') != '1':
            return self._json(403, {'error': '缺少 X-Timespell 请求头'})
        if not PUBLIC and self.client_address[0] not in ('127.0.0.1', '::1'):
            return self._json(403, {'error': '只接受本机请求'})
        if PUBLIC and not self.rate_ok(path):
            return self._json(429, {'error': '请求太频繁，请过一会儿再试（在线版每小时有次数限制，本地运行没有）'})
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            return self._json(413, {'error': '请求太大'})
        try:
            req = json.loads(self.rfile.read(n) or b'{}')
            assert isinstance(req, dict)
        except Exception:
            return self._json(400, {'error': '请求不是合法 JSON'})
        if path == '/api/chat':
            if PUBLIC and not _busy.acquire(blocking=False):
                return self._json(429, {'error': '同时生成的人太多，请过几分钟再试'})
            try:
                return self.proxy(req, '/chat/completions', 'POST', req.get('body'))
            finally:
                if PUBLIC:
                    _busy.release()
        if path == '/api/models':
            return self.proxy(req, '/models', 'GET', None)
        if path == '/api/objects':
            return self.save_object(req)
        self._json(404, {'error': 'unknown api'})

    def proxy(self, req, suffix, method, body):
        base = str(req.get('base') or '').strip().rstrip('/')
        u = urllib.parse.urlsplit(base)
        if u.scheme not in ('http', 'https') or not u.hostname:
            return self._json(400, {'error': 'API 地址要以 http:// 或 https:// 开头'})
        if PUBLIC:
            host = u.hostname.lower()
            if u.scheme != 'https' or not any(host == h or host.endswith('.' + h) for h in ALLOWED_HOSTS):
                return self._json(400, {'error': '在线版只能转发到这些 AI 服务：' + '、'.join(ALLOWED_HOSTS) + '。其它地址请在本地运行'})
        if body is not None and not isinstance(body, dict):
            return self._json(400, {'error': 'body 必须是 JSON 对象'})
        headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json'}
        if req.get('key'):
            headers['Authorization'] = 'Bearer ' + str(req['key']).strip()
        data = json.dumps(body).encode() if body is not None else None
        up = urllib.request.Request(base + suffix, data=data, method=method, headers=headers)
        try:
            resp = _opener.open(up, timeout=1800)
        except urllib.error.HTTPError as e:
            return self._json(e.code, {'error': e.read().decode('utf8', 'replace')[:2000]})
        except Exception as e:
            return self._json(502, {'error': '连不上 ' + base + '：' + str(e)})
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
            pass   # 浏览器取消了生成
        finally:
            resp.close()

    def save_object(self, req):
        html = str(req.get('html') or '')
        name = str(req.get('name') or '未命名物品').strip()[:40]
        if '<html' not in html.lower() or len(html) > 2_000_000:
            return self._json(400, {'error': '内容不是完整的 HTML 或过大'})
        USER_DIR.mkdir(parents=True, exist_ok=True)
        if PUBLIC:
            cleanup_user_dir()
            oid = uuid.uuid4().hex   # 随机文件名：不进公共列表，别人猜不到
            (USER_DIR / (oid + '.html')).write_text(html, encoding='utf8')
            return self._json(200, {'id': oid, 'name': name, 'src': 'objects/user/' + oid + '.html', 'expires_days': KEEP_DAYS})
        oid = 'u' + time.strftime('%Y%m%d-%H%M%S')
        while (USER_DIR / (oid + '.html')).exists():
            oid += 'b'
        (USER_DIR / (oid + '.html')).write_text(html, encoding='utf8')
        index = read_index()
        index[oid] = {'name': name, 'prompt': str(req.get('prompt') or '')[:500], 'model': str(req.get('model') or '')[:80]}
        (USER_DIR / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf8')
        self._json(200, {'id': oid, 'name': name, 'src': 'objects/user/' + oid + '.html'})


def cleanup_user_dir():
    files = sorted(USER_DIR.glob('*.html'), key=lambda f: f.stat().st_mtime)
    cutoff = time.time() - KEEP_DAYS * 86400
    for i, f in enumerate(files):
        if f.stat().st_mtime < cutoff or len(files) - i >= MAX_USER_FILES:
            f.unlink(missing_ok=True)


def list_builtin():
    try:
        return json.loads(BUILTIN_INDEX.read_text(encoding='utf8'))
    except Exception as e:
        sys.stderr.write('objects/index.json 读取失败：' + str(e) + chr(10))
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
        out.append({'id': f.stem, 'name': meta.get('name', f.stem), 'src': 'objects/user/' + f.name, 'prompt': meta.get('prompt', '')})
    return out


if __name__ == '__main__':
    host = os.environ.get('HOST') or ('0.0.0.0' if PUBLIC else '127.0.0.1')
    port = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get('PORT') or (7860 if PUBLIC else 8765))
    mode = 'public' if PUBLIC else 'local'
    print('Time Simulator (' + mode + ' mode): http://' + host + ':' + str(port) + '/', flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
