"""生成物品的通用修补：嵌入模式下强制 html 和 body 背景透明（模型经常只把画布设成透明，结果整页黑底盖住摄像头画面）。
网页设置面板（studio.js 的 checkHtml）做同样的事。
"""
import re

MARK = 'ts-embed'
SNIPPET = ('<style>html.ts-embed, html.ts-embed body { background: transparent !important; }</style>\n'
           "<script>if (new URLSearchParams(location.search).get('embed') === '1') document.documentElement.classList.add('ts-embed');</script>\n")


def ensure_embed_transparent(html):
    if MARK in html:
        return html, False
    m = re.search(r'<head[^>]*>', html, re.I) or re.search(r'<html[^>]*>', html, re.I)
    if m:
        return html[:m.end()] + '\n' + SNIPPET + html[m.end():], True
    return SNIPPET + html, True


if __name__ == '__main__':
    import pathlib, sys
    for f in sys.argv[1:]:
        p = pathlib.Path(f)
        html, changed = ensure_embed_transparent(p.read_text(encoding='utf8'))
        if changed:
            p.write_text(html, encoding='utf8')
        print(f, '已修补' if changed else '无需修补')
