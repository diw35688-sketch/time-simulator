"""生成真实手势测试视频：把一张张开的手（tests/data/hand.png）按已知的位置和角度合成为 30fps 的 y4m 视频，
给 Chrome 当虚拟摄像头（--use-file-for-fake-video-capture），用真的 MediaPipe 识别来测跟手和拨时间。
用法：python tests/make_hand_video.py [输出目录]，默认写到系统临时目录；同时写出每帧真值 truth.json
"""
import json, math, pathlib, subprocess, sys, tempfile
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent
W, H, FPS = 640, 360, 30
PALM, PALM_LEN = (0.5474, 0.539), 0.3072   # hand.png 里手掌中心的位置、手掌长度（手腕到中指根），都是占图片边长的比例
L = 80                                      # 视频里的手掌长度（像素）
DISP_W, DISP_H = 1280, 720                  # 测试页面的窗口大小，真值按它换算
A, O = (260, 360), (640, 432)               # 显示坐标：离物品远的位置、物品中心

# 时间线：(秒, 状态函数)；状态是显示坐标里的手掌中心和顺时针转角（0 = 手指朝上），None = 画面里没有手
SEGMENTS = [
    (2, lambda k: None),
    (2, lambda k: (A, 0)),
    (1, lambda k: ((A[0] + (O[0] - A[0]) * k, A[1] + (O[1] - A[1]) * k), 0)),
    (1, lambda k: (O, 0)),
    (2, lambda k: (O, 60 * k)),
    (1, lambda k: (O, 60)),
    (2, lambda k: (O, 60 - 60 * k)),
    (1, lambda k: (O, 0)),
    (2, lambda k: (O, 30 * k)),
    (1.5, lambda k: (O, 30)),
    (0.5, lambda k: None),
]


def state(t):
    t0 = 0
    for dur, fn in SEGMENTS:
        if t < t0 + dur:
            return fn((t - t0) / dur)
        t0 += dur
    return None


def main():
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.gettempdir()) / 'timesim-hand'
    out.mkdir(parents=True, exist_ok=True)
    hand = Image.open(ROOT / 'data' / 'hand.png').convert('RGBA')
    k = L / (PALM_LEN * hand.width)
    hand = hand.resize((round(hand.width * k), round(hand.height * k)), Image.LANCZOS)
    px, py = PALM[0] * hand.width, PALM[1] * hand.height
    S = int(2 * max(math.hypot(px - cx, py - cy) for cx in (0, hand.width) for cy in (0, hand.height))) + 4
    pad = Image.new('RGBA', (S, S))
    pad.paste(hand, (round(S / 2 - px), round(S / 2 - py)))
    yy, xx = np.mgrid[0:H, 0:W]
    bg = (np.dstack([38 + 30 * yy / H + 8 * xx / W] * 3) * [1.0, 1.02, 1.08]).astype(np.float32)
    rng = np.random.default_rng(7)
    total = sum(d for d, _ in SEGMENTS)
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-pix_fmt', 'yuv420p', str(out / 'hand.y4m')], stdin=subprocess.PIPE)
    truth = []
    for i in range(int(total * FPS)):
        t = i / FPS
        st = state(t)
        frame = Image.fromarray(np.clip(bg + rng.normal(0, 2.0, bg.shape), 0, 255).astype(np.uint8), 'RGB')
        if st:
            (dx, dy), ang = st
            # 画面是镜像显示的：显示里顺时针，在原始画面里是逆时针（PIL 的 rotate 正角度就是逆时针）
            rx, ry = (1 - dx / DISP_W) * W, dy / DISP_H * H
            rot = pad.rotate(ang, resample=Image.BICUBIC)
            frame.paste(rot, (round(rx - S / 2), round(ry - S / 2)), rot)
        ff.stdin.write(frame.tobytes())
        truth.append({'i': i, 't': round(t * 1000, 1), 'hand': bool(st), 'x': st[0][0] if st else None, 'y': st[0][1] if st else None, 'roll': st[1] if st else None})
    ff.stdin.close(); ff.wait()
    (out / 'truth.json').write_text(json.dumps({'fps': FPS, 'frames': truth, 'palm_len_display': L * DISP_W / W}), encoding='utf8')
    print(json.dumps({'video': str(out / 'hand.y4m'), 'frames': len(truth), 'MB': round((out / 'hand.y4m').stat().st_size / 1e6, 1)}))


if __name__ == '__main__':
    main()
