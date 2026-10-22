"""给物品页补上一段统一的脚本（内容在 prompts/embed_fix.html，网页设置面板生成物品时也用同一段）：
嵌入模式下强制页面背景透明，时间没变时降低重画频率。重复运行是安全的：旧版本的补丁会被换成新的。
用法：python tools/objfix.py objects/*.html
"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
SNIPPET = (ROOT / 'prompts' / 'embed_fix.html').read_text(encoding='utf8').strip() + chr(10)
OLD_V1 = ('<style>html.ts-embed, html.ts-embed body { background: transparent !important; }</style>' + chr(10) +
          "<script>if (new URLSearchParams(location.search).get('embed') === '1') document.documentElement.classList.add('ts-embed');</script>" + chr(10))


def ensure_embed_transparent(html):
    if SNIPPET in html:
        return html, False
    if OLD_V1 in html:
        return html.replace(OLD_V1, SNIPPET, 1), True
    m = re.search(r'<head[^>]*>', html, re.I) or re.search(r'<html[^>]*>', html, re.I)
    if m:
        return html[:m.end()] + chr(10) + SNIPPET + html[m.end():], True
    return SNIPPET + html, True


if __name__ == '__main__':
    import sys
    for f in sys.argv[1:]:
        p = pathlib.Path(f)
        html, changed = ensure_embed_transparent(p.read_text(encoding='utf8'))
        if changed:
            p.write_text(html, encoding='utf8')
        print(f, '已修补' if changed else '无需修补')
