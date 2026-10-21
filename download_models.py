"""把 MediaPipe 手势和姿态识别的运行文件下载到 vendor/mediapipe（约 33MB）。
页面优先用本地文件；不下载也能用，但要从 jsdelivr 和 Google 存储在线加载，国内经常加载不动。
需要代理时先设置 HTTPS_PROXY 环境变量。用法：python download_models.py
"""
import pathlib, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent / 'vendor' / 'mediapipe'
CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14'
MODELS = 'https://storage.googleapis.com/mediapipe-models'
FILES = [
    (f'{CDN}/vision_bundle.mjs', 'vision_bundle.mjs'),
    (f'{CDN}/wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.js'),
    (f'{CDN}/wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_internal.wasm'),
    (f'{CDN}/wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.js'),
    (f'{CDN}/wasm/vision_wasm_nosimd_internal.wasm', 'wasm/vision_wasm_nosimd_internal.wasm'),
    (f'{MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', 'hand_landmarker.task'),
    (f'{MODELS}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', 'pose_landmarker_lite.task'),
]


def fetch(url, out):
    tmp = out.with_name(out.name + '.part')
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(tmp, 'wb') as f:
                total, done = int(r.headers.get('Content-Length') or 0), 0
                while chunk := r.read(1 << 16):
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        print(f'\r  {done / total:6.1%}  {done / 1e6:5.1f}/{total / 1e6:.1f} MB', end='', flush=True)
            print()
            if total and done != total:
                raise IOError(f'只收到 {done}/{total} 字节')
            tmp.replace(out)
            return True
        except Exception as e:
            print(f'\n  第 {attempt} 次失败：{e}')
    tmp.unlink(missing_ok=True)
    return False


def main():
    failed = []
    for url, rel in FILES:
        out = ROOT / rel
        if out.exists() and out.stat().st_size > 0:
            print(f'已存在 {rel}')
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        print(f'下载 {rel}')
        if not fetch(url, out):
            failed.append(rel)
    for f in sorted(ROOT.rglob('*')):
        if f.is_file():
            print(f'{f.stat().st_size / 1e6:7.2f} MB  {f.relative_to(ROOT).as_posix()}')
    if failed:
        sys.exit('下载失败：' + '、'.join(failed) + '。检查网络，或设置 HTTPS_PROXY 后重试')


if __name__ == '__main__':
    main()
