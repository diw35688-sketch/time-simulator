"""把时间模拟器部署到魔搭创空间（Docker 类型，用免费的 2 核 16G CPU 实例）。

准备：
  1. python download_models.py              # 模型文件要一起传上去，国内访问不了 Google 的模型地址
  2. modelscope login --token 你的访问令牌   # 令牌在 https://modelscope.cn/my/myaccesstoken
用法：
  python tools/deploy_modelscope.py 你的魔搭用户名/time-simulator
会打包当前提交（git HEAD）和 vendor/mediapipe，强制推送到创空间仓库并触发部署。
"""
import argparse, base64, hashlib, io, json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHUNK = 4 * 1024 * 1024
MODEL_FILES = ['vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js',
               'wasm/vision_wasm_nosimd_internal.wasm', 'hand_landmarker.task', 'pose_landmarker_lite.task']
# 魔搭在国内直连更稳，走代理反而握手失败
ENV = {k: v for k, v in os.environ.items() if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy')}
ENV['NO_PROXY'] = 'modelscope.cn,.modelscope.cn,' + os.environ.get('NO_PROXY', '')


def tokens():
    from modelscope_hub import HubApi
    cfg = HubApi()._config
    api_token = os.environ.get('MODELSCOPE_API_TOKEN') or getattr(cfg, 'token', None)
    git_token = cfg.load_git_token() if hasattr(cfg, 'load_git_token') else None
    if not api_token:
        sys.exit('没有找到魔搭令牌：先运行 modelscope login --token 你的访问令牌，或设置 MODELSCOPE_API_TOKEN')
    return api_token, git_token or api_token


def run(cmd, cwd=None, secret=None):
    shown = ' '.join(cmd if not secret else [c.replace(secret, '***') for c in cmd])
    print('$', shown[:200])
    r = subprocess.run(cmd, cwd=cwd, env=ENV, capture_output=True, text=True, encoding='utf8', errors='replace')
    out = (r.stdout + r.stderr).strip()
    if secret:
        out = out.replace(secret, '***')
    if out:
        print(out[-3000:])
    if r.returncode:
        sys.exit('命令失败，退出码 ' + str(r.returncode))
    return out


def assemble(dest):
    # 只打包已提交的文件，保证线上和 GitHub 上的代码一致
    data = subprocess.run(['git', 'archive', '--format=tar', 'HEAD'], cwd=ROOT, capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        t.extractall(dest, filter='data')
    src, out = ROOT / 'vendor' / 'mediapipe', dest / 'vendor' / 'mediapipe'
    missing = [f for f in MODEL_FILES if not (src / f).is_file()]
    if missing:
        sys.exit('缺少模型文件 ' + '、'.join(missing) + '，先运行 python download_models.py')
    manifest = {}
    for rel in MODEL_FILES:
        blob = (src / rel).read_bytes()
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if len(blob) <= CHUNK:
            target.write_bytes(blob)
            continue
        n = (len(blob) + CHUNK - 1) // CHUNK
        for i in range(n):
            (out / (rel + '.part' + str(i))).write_bytes(blob[i * CHUNK:(i + 1) * CHUNK])
        manifest[rel] = {'parts': n, 'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()}
    (out / 'parts.json').write_text(json.dumps(manifest, indent=1), encoding='utf8')
    big = [p for p in dest.rglob('*') if p.is_file() and p.stat().st_size > CHUNK + 1024 * 1024]
    if big:
        sys.exit('还有超过 5MB 的文件：' + '、'.join(str(p.relative_to(dest)) for p in big))
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('repo_id', help='魔搭用户名/创空间名，例如 alice/time-simulator')
    ap.add_argument('--no-deploy', action='store_true', help='只推送代码，不触发部署')
    a = ap.parse_args()
    api_token, git_token = tokens()
    sha = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    run(['modelscope', '--token', api_token, 'create', a.repo_id, '--repo-type', 'studio', '--sdk-type', 'docker', '--visibility', 'public',
         '--chinese-name', '时间模拟器', '--license', 'mit', '--exist-ok',
         '--description', '张开手掌召唤法阵，转动手腕拨动物品的时间；一句话用 AI 生成新的 3D 时间物品'], secret=api_token)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='timesim-deploy-'))
    try:
        manifest = assemble(tmp)
        print('拆分的大文件：', {k: v['parts'] for k, v in manifest.items()})
        auth = base64.b64encode(('oauth2:' + git_token).encode()).decode()
        git = ['git', '-c', 'http.proxy=', '-c', 'http.extraHeader=Authorization: Basic ' + auth]
        run(['git', 'init', '-q', '-b', 'master'], cwd=tmp)
        run(['git', 'add', '-A'], cwd=tmp)
        run(['git', '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'deploy ' + sha], cwd=tmp)
        url = 'https://www.modelscope.cn/studios/' + a.repo_id + '.git'
        run(git + ['push', '--force', url, 'master:master'], cwd=tmp, secret=auth)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not a.no_deploy:
        run(['modelscope', '--token', api_token, 'studio', 'deploy', a.repo_id], secret=api_token)
    print('创空间：https://www.modelscope.cn/studios/' + a.repo_id)
    print('看构建日志：modelscope studio logs ' + a.repo_id + ' --type build')


if __name__ == '__main__':
    main()
