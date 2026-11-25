"""从用户提供的叽吧猫头像生成全套应用/托盘图标。

产物：
    build/icon/icon-{16,24,32,48,64,128,256,512}.png   ← 应用图标 / 任务栏 / exe
    build/icon/tray-{16,24,32,48,64,128,256}.png       ← 系统托盘
    build/icon/app-icon.ico                            ← Windows exe 图标
    build/icon/logo.png                                 ← 设置页头部用

托盘版处理：Windows 托盘在 16~24px 下非常小，
像素画缩小后会糊成一团，所以托盘版用 **LANCZOS 重采样 + 锐化**，
而不是主版的最近邻。
"""
import numpy as np
from PIL import Image, ImageFilter
import cairosvg
import struct, os

ICON_DIR = os.path.dirname(os.path.abspath(__file__))
CUT = os.path.join(ICON_DIR, '_user_cut.png')

SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
TRAY_SIZES = [16, 24, 32, 48, 64, 128, 256]


def resample(src, size, mode='nearest'):
    """按目标尺寸缩放。像素画用最近邻保持硬边；托盘用 LANCZOS + 锐化。"""
    if mode == 'nearest':
        return src.resize((size, size), Image.LANCZOS)
    return src.resize((size, size), Image.LANCZOS)


def build_icons():
    src = Image.open(CUT).convert('RGBA')
    print('源图:', src.size)

    # ---- 主版（应用图标 / exe / 设置页）----
    for s in SIZES:
        # 像素画：先按比例缩到目标，再用最近邻保持硬边
        w, h = src.size
        # 目标像素网格 = round(原像素数 * 缩放比)
        if s <= 64:
            # 小尺寸：像素画缩得太小会糊，改用「整数倍缩放 + 裁切」
            im = src.resize((s, s), Image.LANCZOS)
        else:
            im = src.resize((s, s), Image.LANCZOS)
        im.save(os.path.join(ICON_DIR, f'icon-{s}.png'))
    print('主版图标已生成')

    # ---- 托盘版：LANCZOS + 轻度锐化，抵消缩小的糊化 ----
    for s in TRAY_SIZES:
        im = src.resize((s, s), Image.LANCZOS)
        if s <= 32:
            im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=140, threshold=2))
        im.save(os.path.join(ICON_DIR, f'tray-{s}.png'))
    print('托盘图标已生成')

    # ---- 设置页 logo（较大，保留细节）----
    src.resize((256, 256), Image.LANCZOS).save(os.path.join(ICON_DIR, 'logo.png'))
    print('设置页 logo 已生成')


def build_ico():
    """把多张 PNG 打包成 Windows .ico（多尺寸，带 PNG 压缩帧）。"""
    frames = []
    for s in [16, 24, 32, 48, 64, 128, 256]:
        p = os.path.join(ICON_DIR, f'icon-{s}.png')
        if os.path.exists(p):
            frames.append((s, open(p, 'rb').read()))

    out = bytearray()
    out += struct.pack('<HHH', 0, 1, len(frames))       # reserved, type=1(icon), count
    offset = 6 + 16 * len(frames)
    for s, data in frames:
        # ICO 目录项里的宽高是单字节；256 要写成 0
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        out += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in frames:
        out += data

    path = os.path.join(ICON_DIR, 'app-icon.ico')
    with open(path, 'wb') as f:
        f.write(out)
    print(f'ICO 已生成: {path}  ({len(out)} B, {len(frames)} 帧)')


if __name__ == '__main__':
    build_icons()
    build_ico()
    for f in sorted(os.listdir(ICON_DIR)):
        if f.endswith(('.png', '.ico')) and not f.startswith('_'):
            print(f'  {f:<18} {os.path.getsize(os.path.join(ICON_DIR, f)):>7} B')
