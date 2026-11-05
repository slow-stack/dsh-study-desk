# 最终确认图：旧色 vs 新色，浅底/深底各一列。
import os
from PIL import Image, ImageDraw, ImageFont

S = os.path.join(os.path.dirname(__file__), '..', '.shots')
p = lambda n: os.path.join(S, n)
try:
    F = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 19)
    FS = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 14)
except Exception:
    F = FS = ImageFont.load_default()
BG, FG = (24, 26, 30), (234, 236, 240)
# 裁切框来自 harness 的 diag（两种主题同一套布局）
BOX = {'heat': (236, 1206, 646, 1446), 'bars': (258, 640, 1216, 782)}
SCALE = {'heat': 2, 'bars': 1}


def sheet(kind, title, old_src, new_src):
    sc = SCALE[kind]
    rows = []
    for label, src in [('旧：品牌色（主题里掉成灰阶）', old_src), ('新：' + {'heat': '绿色阶', 'bars': '暖色（今天转红）'}[kind], new_src)]:
        cells = []
        for dk, tag in [(0, '浅底'), (1, '深底')]:
            im = Image.open(p(f'{src}-{dk}.png')).convert('RGB').crop(BOX[kind])
            im = im.resize((im.width * sc, im.height * sc), Image.LANCZOS)
            bar = Image.new('RGB', (im.width, im.height + 22), BG)
            ImageDraw.Draw(bar).text((8, 3), tag, font=FS, fill=FG)
            bar.paste(im, (0, 22))
            cells.append(bar)
        roww = sum(c.width for c in cells) + 16
        row = Image.new('RGB', (roww, max(c.height for c in cells)), BG)
        x = 0
        for c in cells:
            row.paste(c, (x, 0))
            x += c.width + 16
        rows.append((label, row))
    lw = 330
    out = Image.new('RGB', (lw + max(r.width for _, r in rows) + 32, 56 + sum(r.height + 30 for _, r in rows)), BG)
    d = ImageDraw.Draw(out)
    d.text((16, 14), title, font=F, fill=FG)
    y = 56
    for label, row in rows:
        d.text((16, y + 6), label, font=FS, fill=FG)
        out.paste(row, (lw, y))
        y += row.height + 30
    out.save(p(f'final-{kind}.png'))
    print('final-%s.png' % kind, out.size)


sheet('heat', '学习热力图 · 改色前后', 'g-cur', 'final')
sheet('bars', '今日复习 · 未来 7 天柱状图 改色前后', 'g-cur', 'final')
