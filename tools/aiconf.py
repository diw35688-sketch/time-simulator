"""读取 AI 接口配置，给命令行工具和测试脚本用（网页设置面板不读这里，Key 存在浏览器里）。
优先级：环境变量 > --env-file 或 TIMESPELL_ENV_FILE 指定的文件 > 项目根目录的 .env
变量：TIMESPELL_API_BASE、TIMESPELL_API_KEY，可选 TIMESPELL_MODEL、TIMESPELL_IMAGE_MODEL（格式见 .env.example）
"""
import os, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAMES = {'base': 'TIMESPELL_API_BASE', 'key': 'TIMESPELL_API_KEY', 'model': 'TIMESPELL_MODEL', 'image_model': 'TIMESPELL_IMAGE_MODEL'}


def parse_env_file(path):
    out, p = {}, pathlib.Path(path)
    if not p.is_file():
        return out
    for line in p.read_text(encoding='utf8').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def load(env_file=None):
    file = env_file or os.environ.get('TIMESPELL_ENV_FILE') or ROOT / '.env'
    conf = {**parse_env_file(file), **{k: v for k, v in os.environ.items() if k.startswith('TIMESPELL_')}}
    out = {field: conf.get(name, '') for field, name in NAMES.items()}
    out['base'] = out['base'].rstrip('/')
    return out


def require(conf, *fields):
    missing = [NAMES[f] for f in fields if not conf.get(f)]
    if missing:
        raise SystemExit('缺少配置：' + '、'.join(missing) + '。设置环境变量，或把 .env.example 复制成 .env 后填写')
    return conf
