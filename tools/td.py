"""命令行调用 AI 接口生成物品或图片：网页设置面板的命令行版，方便批量生成。
配置见 tools/aiconf.py（环境变量 TIMESPELL_API_BASE / TIMESPELL_API_KEY / TIMESPELL_MODEL，或项目根目录 .env）。

  python tools/td.py object --desc "一根点燃的白蜡烛。过去：…；未来：…" --out objects/user/candle.html
  python tools/td.py object --task-file 自己写的任务书.md --out objects/user/x.html
  python tools/td.py image --prompt-file p.txt --out a.png --model <生图模型> [--extra '{"watermark": false}']

生成的物品用 python tests/check_object.py <文件> 验收。网页面板会自动做语法检查和修复，命令行版不做。
"""
import argparse, base64, json, pathlib, re, sys, time, urllib.error, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import aiconf
from objfix import ensure_embed_transparent

TEMPLATE = aiconf.ROOT / 'prompts' / 'object_task.md'
SYSTEM = '你是资深 three.js 图形工程师。只输出一个完整的 ```html 代码块，然后用一句话说明阶段设计。'


def post(conf, path, body, timeout=600):
    req = urllib.request.Request(conf['base'] + path, data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': 'Bearer ' + conf['key'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(json.dumps({'status': 'error', 'code': e.code, 'body': e.read().decode('utf8', 'replace')[:800]}, ensure_ascii=False))


def image(conf, a):
    out = pathlib.Path(a.out)
    if out.exists() and not a.overwrite:
        sys.exit(f'{out} 已存在，加 --overwrite 覆盖')
    model = a.model or aiconf.require(conf, 'image_model')['image_model']
    body = {'model': model, 'prompt': pathlib.Path(a.prompt_file).read_text(encoding='utf8'), 'size': a.size, 'n': 1,
            'response_format': 'b64_json', **json.loads(a.extra or '{}')}
    t0 = time.time()
    item = post(conf, '/images/generations', body)['data'][0]
    if item.get('b64_json'):
        raw = base64.b64decode(item['b64_json'])
    else:
        with urllib.request.urlopen(item['url'], timeout=120) as r:
            raw = r.read()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(raw)
    print(json.dumps({'output': str(out), 'bytes': len(raw), 'seconds': round(time.time() - t0, 1)}))


def obj(conf, a):
    if a.task_file:
        task = pathlib.Path(a.task_file).read_text(encoding='utf8')
    elif a.desc:
        task = TEMPLATE.read_text(encoding='utf8').replace('{{OBJECT}}', a.desc)
    else:
        sys.exit('需要 --desc（一句话描述）或 --task-file（完整任务书）')
    model = a.model or aiconf.require(conf, 'model')['model']
    body = {'model': model, 'max_tokens': a.max_tokens, 'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': task}]}
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    d = post(conf, '/chat/completions', body, timeout=1800)
    out.with_suffix('.response.json').write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding='utf8')
    choice = d['choices'][0]
    text = choice['message'].get('content') or ''
    out.with_suffix('.raw.md').write_text(text, encoding='utf8')
    if not text:
        sys.exit(json.dumps({'status': 'empty', 'finish_reason': choice.get('finish_reason'), 'usage': d.get('usage'),
                             'hint': 'finish_reason 为 length 时，思考过程用光了额度，调大 --max-tokens'}, ensure_ascii=False))
    m = re.search(r'```html\s*(.*?)```', text, re.S)
    if not m:
        sys.exit(f'回复里没有 html 代码块，原文在 {out.with_suffix(".raw.md")}')
    html, _ = ensure_embed_transparent(m.group(1).strip() + chr(10))
    out.write_text(html, encoding='utf8')
    print(json.dumps({'output': str(out), 'chars': len(m.group(1)), 'usage': d.get('usage'), 'seconds': round(time.time() - t0, 1),
                      'note': text[m.end():].strip()[:300]}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--env-file', help='配置文件路径，默认项目根目录的 .env')
    ap.add_argument('--dry-run', action='store_true', help='只打印读到的配置（不显示 Key），不发请求')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('object', help='生成一个 3D 时间物品')
    p.add_argument('--desc'); p.add_argument('--task-file'); p.add_argument('--out', required=True)
    p.add_argument('--model'); p.add_argument('--max-tokens', type=int, default=100000)
    p = sub.add_parser('image', help='生成一张图片（OpenAI 兼容的 /images/generations）')
    p.add_argument('--prompt-file', required=True); p.add_argument('--out', required=True); p.add_argument('--model')
    p.add_argument('--size', default='2048x2048'); p.add_argument('--extra', help='附加请求参数，JSON'); p.add_argument('--overwrite', action='store_true')
    a = ap.parse_args()
    conf = aiconf.require(aiconf.load(a.env_file), 'base', 'key')
    if a.dry_run:
        print(json.dumps({'base': conf['base'], 'key_set': bool(conf['key']), 'model': a.model or conf['model'], 'image_model': conf['image_model']}, ensure_ascii=False))
        return
    {'object': obj, 'image': image}[a.cmd](conf, a)


if __name__ == '__main__':
    main()
