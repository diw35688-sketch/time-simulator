"""把 deploy_modelscope.py 拆开的大文件拼回去。Docker 构建时运行，没有 parts.json 就什么都不做。
用法：python tools/join_parts.py vendor/mediapipe
"""
import hashlib, json, pathlib, sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'vendor/mediapipe')
manifest = root / 'parts.json'
if not manifest.exists():
    sys.exit(0)
for rel, meta in json.loads(manifest.read_text(encoding='utf8')).items():
    parts = [root / (rel + '.part' + str(i)) for i in range(meta['parts'])]
    data = b''.join(p.read_bytes() for p in parts)
    if len(data) != meta['size'] or hashlib.sha256(data).hexdigest() != meta['sha256']:
        sys.exit(rel + ' 拼接后校验失败')
    (root / rel).write_bytes(data)
    for p in parts:
        p.unlink()
    print('joined', rel, len(data), 'bytes')
manifest.unlink()
