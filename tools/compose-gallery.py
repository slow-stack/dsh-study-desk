# 把三套候选色 + 现在这版拼成两张可选对照表（热力图、复习柱状图），深浅底各一列。
import os
from PIL import Image, ImageDraw, ImageFont

S = os.path.join(os.path.dirname(__file__), '..', '.shots')
p = lambda n: os.path.join(S, n)
try:
    F = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 20)
    FS = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 15)
except Exception:
    F = FS = ImageFont.load_default()

BG = (24, 26, 30)
FG = (234, 236, 240)
VARIANTS = [('cur', '现在这版（品牌色，深色主题下接近灰白）'), ('green', 'A 绿色阶梯'), ('warm', 'B 暖色番茄（琥珀→红）'), ('teal', 'C 青色')]
# rect 来自 harness 的 diag：heat=281,1246,230,131  forecast=281,672,913,71（两种主题同一套布局）
BOX = {'heat': (236, 1210, 640, 1442), 'bars': (258, 640, 1216, 780)}


def sheet(kind, title):
    scale = 2 if kind == 'heat' else 1
    rows = []
    for key, label in VARIANTS:
        ims = []
        for dk in (0, 1):
            im = Image.open(p(f'g-{key}-{dk}.png')).convert('RGB').crop(BOX[kind])
            im = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
            ims.append(im)
        h = min(i.height for i in ims)
        cells = []
        for i, tag in zip(ims, ['浅底', '深底']):
            bar = Image.new('RGB', (i.width, i.height + 24), BG)
            d = ImageDraw.Draw(bar)
            d.text((8, 3), tag, font=FS, fill=FG)
            bar.paste(i, (0, 24))
            cells.append(bar.crop((0, 0, i.width, h + 24)))
        roww = sum(c.width for c in cells) + 16
        row = Image.new('RGB', (roww, max(c.height for c in cells)), BG)
        x = 0
        for c in cells:
            row.paste(c, (x, 0))
            x += c.width + 16
        rows.append((label, row))

    labelw = 460
    W = labelw + max(r.width for _, r in rows) + 32
    H = 60 + sum(28 + r.height for _, r in rows) + 16 * len(rows)
    out = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(out)
    d.text((16, 16), title, font=F, fill=FG)
    y = 60
    for label, row in rows:
        d.text((16, y + row.height // 2 - 10), label, font=FS, fill=FG)
        out.paste(row, (labelw, y))
        y += row.height + 16 + 12
    out.save(p(f'gallery-{kind}.png'))
    print('gallery-%s.png' % kind, out.size)


sheet('heat', '学习热力图：四套候选色')
sheet('bars', '今日复习卡 · 未来 7 天柱状图：四套候选色')
