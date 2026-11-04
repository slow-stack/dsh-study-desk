# 把 .shots 里的截图拼成两张对照图：整页 2x2、饼图放大对照。
# 只在本地生成（.shots 已 gitignore），不上传任何东西。
import os
from PIL import Image, ImageDraw, ImageFont

S = os.path.join(os.path.dirname(__file__), '..', '.shots')
p = lambda n: os.path.join(S, n)

try:
    FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 22)
    FONTS = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 17)
except Exception:
    FONT = FONTS = ImageFont.load_default()

BG = (24, 26, 30)
FG = (232, 234, 238)


def labeled(img, text, font):
    bar = font.size + 16
    out = Image.new('RGB', (img.width, img.height + bar), BG)
    out.paste(img, (0, bar))
    d = ImageDraw.Draw(out)
    d.text((12, 6), text, font=font, fill=FG)
    return out


def grid(items, cols, w, gap=20, labels_above=True):
    cells = []
    for img, text in items:
        scale = w / img.width
        im = img.resize((w, int(img.height * scale)), Image.LANCZOS)
        cells.append(labeled(im, text, FONTS) if labels_above else im)
    rows = [cells[i:i + cols] for i in range(0, len(cells), cols)]
    rh = [max(c.height for c in r) for r in rows]
    W = sum(c.width for c in rows[0]) + gap * (cols + 1)
    H = sum(rh) + gap * (len(rows) + 1)
    out = Image.new('RGB', (W, H), BG)
    y = gap
    for r, h in zip(rows, rh):
        x = gap
        for c in r:
            out.paste(c, (x, y))
            x += c.width + gap
        y += h + gap
    return out


# ---- 1. 整页对照
pairs = [('old-light.png', '改前 · 浅色'), ('new-light.png', '改后 · 浅色'),
         ('old-dark.png', '改前 · 深色'), ('new-dark.png', '改后 · 深色')]
imgs = [(Image.open(p(n)).convert('RGB'), t) for n, t in pairs]
grid(imgs, 2, 600).save(p('compare.png'))

# ---- 2. 饼图放大对照（rect 从 harness 的 diag 里读到）
RECTS = {'old': (862, 1044, 335, 112), 'new': (861, 1082, 333, 117)}
PAD = 14
crops = []
for v, label in [('old', '改前 · 灰阶语义色（5 色里有 3 个其实是灰的）'), ('new', '改后 · 宿主色板分色')]:
    x, y, w, h = RECTS[v]
    box = (max(0, x - PAD), max(0, y - PAD), x + w + PAD, y + h + PAD)
    im = Image.open(p(f'{v}-light.png')).convert('RGB').crop(box)
    im = im.resize((im.width * 3, im.height * 3), Image.LANCZOS)
    crops.append((im, label))
grid(crops, 1, 1000, labels_above=True).save(p('pie-compare.png'))

for n in ['compare.png', 'pie-compare.png']:
    im = Image.open(p(n))
    print(n, im.size, os.path.getsize(p(n)) // 1024, 'KB')
