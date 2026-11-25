"""把用户给的截图抠成透明背景（v4 —— 解决白边问题）。

v3 的遗留问题：抠出来的边缘有一圈明显的浅灰白描边。
原因：那圈白边是**原图的抗锯齿中间色**（背景色与猫色的混合），
它的 alpha 被判成了 255（因为它离背景色足够远），所以前面的「去污染」没管到它。

v4 的解法 —— **在原始 60×60 网格上重做分类**，而不是靠形态学：
原图是像素画，每个像素属于明确的少数几种颜色：
    背景  (239,240,242)   冷灰白
    猫身白(248,245,238)   暖米白
    黑    (0~30)          轮廓
    绿    (~150,190,90)   眼睛
    粉    (~190,140,150)  耳内

做法：
1. 对每个像素算「到背景色」和「到猫身白」的距离，取更近的那个作为归属。
   猫身白和背景色虽然接近，但色温不同（R>B vs B>R），用**色温方向**来分。
2. 归属为「猫」的像素构成猫的外形 → 填洞（含内部白色）。
3. 关键：**在原始 60×60 网格上做，而不是放大后**。
   这样抗锯齿的中间色像素会按颜色被正确归类，不会留下 8 倍放大的锯齿白边。
4. 最后用「向内 1px 的深色像素」给外轮廓补一圈黑边，彻底消除白边。
"""
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = r'C:\Users\jtar\Desktop\Snipaste_2026-11-24_15-40-36.png'


def cutout(src=SRC, scale=8, pad_ratio=0.03):
    im = Image.open(src).convert('RGB')
    a = np.array(im).astype(np.float32)
    h, w, _ = a.shape

    # 背景色与「猫身白」色都用采样得到
    bg = np.array([239., 240., 242.])          # 冷灰白
    fur = np.array([248., 245., 238.])         # 暖米白

    d_bg = np.sqrt(((a - bg) ** 2).sum(axis=2))
    d_fur = np.sqrt(((a - fur) ** 2).sum(axis=2))

    # 色温判据：背景 B>R，猫身白 R>B
    # 用「距离 + 色温方向」联合打分，避免两者距离接近时误判
    is_warm = (a[:, :, 0] - a[:, :, 2]) > 3    # 偏暖 → 更可能是猫身白

    # 到猫身白的距离更小，或虽远但明显偏暖 → 判为猫身（不透明白）
    cat_fur = (d_fur < d_bg) | (is_warm & (d_bg < 26))

    # 其余非背景像素（黑/绿/粉）也是猫
    cat_other = d_bg >= 12
    cat = cat_fur | cat_other
    print(f'猫身白 {cat_fur.sum()}  其他 {cat_other.sum()}  合计 {cat.sum()}/{h*w}')

    # 形态学清理（在 60×60 原图上做）
    cat = ndimage.binary_closing(cat, structure=np.ones((3, 3), bool), iterations=1)
    cat = ndimage.binary_fill_holes(cat)
    lab, n = ndimage.label(cat)
    if n > 1:
        sizes = ndimage.sum(cat, lab, range(1, n + 1))
        cat = lab == (int(np.argmax(sizes)) + 1)

    # ---- 关键：用「向内 1px 的像素」重绘外轮廓，消除白边 ----
    inner = ndimage.binary_erosion(cat, np.ones((3, 3), bool), iterations=1)
    # 外轮廓带 = 猫区域里最外的那一圈
    outer_band = cat & ~inner

    rgb = a.copy()
    # 把外轮廓带的颜色换成猫的轮廓黑（采样：区域内最暗像素的中位数）
    dark = rgb[cat & (rgb.mean(axis=2) < 80)]
    edge_color = np.median(dark, axis=0) if len(dark) else np.array([26., 27., 31.])
    print('轮廓色:', edge_color)
    rgb[outer_band] = edge_color

    alpha = (cat * 255).astype(np.uint8)
    out = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), alpha])

    big = Image.fromarray(out, 'RGBA').resize((w * scale, h * scale), Image.NEAREST)
    bbox = big.getbbox()
    if bbox:
        big = big.crop(bbox)
    bw, bh = big.size
    pad = int(max(bw, bh) * pad_ratio)
    canvas = Image.new('RGBA', (bw + pad * 2, bh + pad * 2), (0, 0, 0, 0))
    canvas.paste(big, (pad, pad))
    return canvas


if __name__ == '__main__':
    c = cutout()
    print('输出尺寸:', c.size)
    c.save('_user_cut.png')
    bg = Image.new('RGBA', c.size, (40, 42, 48, 255))
    bg.alpha_composite(c)
    bg.convert('RGB').resize((300, 300), Image.LANCZOS).save('_user_on_dark.png')
    print('已保存')
