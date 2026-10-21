"""server.py 接口测试：物品清单、模型列表转发、流式对话转发、CORS 头。
需要先运行 python server.py，并配置 .env（见 .env.example）。Key 不会打印。
"""
import json, pathlib, sys, urllib.error, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tools'))
import aiconf

B = 'http://127.0.0.1:8765'
conf = aiconf.require(aiconf.load(), 'base', 'key', 'model')
AUTH = {'base': conf['base'], 'key': conf['key']}


def post(path, obj):
    req = urllib.request.Request(B + path, data=json.dumps(obj).encode(), method='POST', headers={'Content-Type': 'application/json'})
    try:
        return urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        return e


r = urllib.request.urlopen(B + '/api/objects'); d = json.load(r)
print('objects', [o['id'] for o in d['builtin']], 'user', len(d['user']), 'CORS', r.headers.get('Access-Control-Allow-Origin'))
r = post('/api/models', AUTH); d = json.load(r)
ids = [m['id'] for m in d.get('data', [])]
print('models', r.status, len(ids), 'has model', conf['model'] in ids)
r = post('/api/models', {'base': 'ftp://x', 'key': ''}); print('bad base', r.status, json.load(r)['error'])
r = post('/api/chat', {**AUTH, 'body': {'model': conf['model'], 'max_tokens': 50, 'stream': True, 'messages': [{'role': 'user', 'content': '只回复：好的'}]}})
chunks, text = 0, ''
for line in r:
    line = line.decode('utf8', 'replace').strip()
    if line.startswith('data:') and line[5:].strip() != '[DONE]':
        chunks += 1
        try:
            text += json.loads(line[5:])['choices'][0]['delta'].get('content') or ''
        except Exception:
            pass
print('stream', r.status, r.headers.get('Content-Type'), 'chunks', chunks, 'text', repr(text[:40]))
