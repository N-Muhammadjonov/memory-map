"""Generate deterministic application icons from the Memory Map graph mark.

Run with Pillow installed. Generated assets are checked in; release builds do
not need Pillow installed just to package the icons.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#10213d"/><stop offset="1" stop-color="#5430a6"/></linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#90f0f6"/><stop offset="1" stop-color="#c2a6ff"/></linearGradient>
    <radialGradient id="halo"><stop stop-color="#6478ff" stop-opacity=".33"/><stop offset="1" stop-color="#6478ff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#base)" stroke="#8c8ae9" stroke-opacity=".28" stroke-width="6"/>
  <circle cx="512" cy="512" r="390" fill="url(#halo)"/>
  <path d="M 284 706 V 310 L 512 531 L 740 310 V 706 M 512 531 V 746" fill="none" stroke="url(#edge)" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>
  <g stroke="#e8f4ff" stroke-width="9"><circle cx="284" cy="310" r="55" fill="#71dfec"/><circle cx="740" cy="310" r="55" fill="#bca1ff"/><circle cx="284" cy="706" r="55" fill="#71dfec"/><circle cx="740" cy="706" r="55" fill="#bca1ff"/><circle cx="512" cy="746" r="39" fill="#bfa6ff"/><circle cx="512" cy="531" r="69" fill="#f1f4ff" stroke="#c6d6ff"/></g>
</svg>\n'''


def make_icon() -> Image.Image:
    mask = Image.new('L', (SIZE, SIZE))
    ImageDraw.Draw(mask).rounded_rectangle((64, 64, 960, 960), radius=210, fill=255)
    bg = Image.new('RGBA', (SIZE, SIZE))
    pixels = bg.load()
    for y in range(SIZE):
        for x in range(SIZE):
            t = (x + y) / (2 * (SIZE - 1))
            pixels[x, y] = tuple(round(a + (b - a) * t) for a, b in zip((16, 33, 61), (84, 48, 166))) + (255,)
    halo = Image.new('RGBA', (SIZE, SIZE))
    ImageDraw.Draw(halo).ellipse((160, 160, 864, 864), fill=(100, 120, 255, 78))
    bg = Image.alpha_composite(bg, halo.filter(ImageFilter.GaussianBlur(135)))
    bg.putalpha(mask)
    d = ImageDraw.Draw(bg)
    d.rounded_rectangle((67, 67, 957, 957), radius=207, outline=(124, 133, 222, 255), width=4)
    points = [(284, 706), (284, 310), (512, 531), (740, 310), (740, 706)]
    for a, b in zip(points, points[1:]):
        d.line((a, b), fill=(160, 211, 250, 255) if a[0] < 512 else (195, 177, 255, 255), width=42)
    d.line(((512, 531), (512, 746)), fill=(186, 175, 250, 255), width=42)
    for x, y, radius, color in [(284,310,55,'#71dfec'),(740,310,55,'#bca1ff'),(284,706,55,'#71dfec'),(740,706,55,'#bca1ff'),(512,746,39,'#bfa6ff'),(512,531,69,'#f1f4ff')]:
        d.ellipse((x-radius,y-radius,x+radius,y+radius), fill=color, outline='#e8f4ff', width=9)
    return bg


def main() -> None:
    for directory in (ROOT/'assets', ROOT/'web/assets', ROOT/'site/assets'):
        directory.mkdir(parents=True, exist_ok=True)
    for path in (ROOT/'assets/memory-map.svg', ROOT/'web/assets/memory-map.svg', ROOT/'site/assets/memory-map.svg'):
        path.write_text(SVG, encoding='utf-8')
    image = make_icon()
    image.save(ROOT/'assets/memory-map.icns', format='ICNS')
    image.save(ROOT/'assets/memory-map.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    for size in (192, 512):
        image.resize((size,size), Image.Resampling.LANCZOS).save(ROOT/f'web/assets/memory-map-{size}.png', optimize=True)
    android = ROOT/'android/app/src/main/res'
    for density, size in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
        directory = android/f'mipmap-{density}'
        directory.mkdir(exist_ok=True)
        image.resize((size,size), Image.Resampling.LANCZOS).save(directory/'ic_launcher.png', optimize=True)


if __name__ == '__main__':
    main()
