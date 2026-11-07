from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
PUBLIC_ICONS = os.path.join(ROOT, 'public', 'icons')
os.makedirs(ASSETS, exist_ok=True)
os.makedirs(PUBLIC_ICONS, exist_ok=True)

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded app tile with a deep navy gradient.
tile = Image.new('RGBA', (S, S), (0, 0, 0, 0))
td = ImageDraw.Draw(tile)
radius = 220
for y in range(S):
    t = y / (S - 1)
    r = int(8 + 7 * t)
    g = int(20 + 22 * t)
    b = int(34 + 26 * t)
    td.line([(0, y), (S, y)], fill=(r, g, b, 255))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([24, 24, S - 24, S - 24], radius=radius, fill=255)
img.alpha_composite(Image.composite(tile, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask))

# Inner highlight.
d.rounded_rectangle([34, 34, S - 34, S - 34], radius=radius - 10, outline=(72, 120, 138, 90), width=5)

# Teal signal arc + dot: "remote".
arc_box = [600, 140, 900, 440]
d.arc(arc_box, start=-58, end=54, fill=(95, 227, 192, 255), width=34)
d.arc([648, 188, 852, 392], start=-58, end=54, fill=(95, 227, 192, 180), width=22)
d.ellipse([844, 262, 884, 302], fill=(95, 227, 192, 255))

# A bold geometric R.
font_path = r'C:\Windows\Fonts\segoeuib.ttf'
if not os.path.exists(font_path):
    font_path = r'C:\Windows\Fonts\arialbd.ttf'
font = ImageFont.truetype(font_path, 470)
text = 'R'
bbox = d.textbbox((0, 0), text, font=font)
w = bbox[2] - bbox[0]
h = bbox[3] - bbox[1]
x = (S - w) / 2 - bbox[0] - 32
y = (S - h) / 2 - bbox[1] + 28
# subtle shadow
d.text((x + 3, y + 5), text, font=font, fill=(0, 0, 0, 55))
d.text((x, y), text, font=font, fill=(246, 252, 255, 255))

# Teal baseline accent under the letter.
d.rounded_rectangle([284, 790, 740, 812], radius=11, fill=(95, 227, 192, 230))

img.save(os.path.join(ASSETS, 'icon.png'))
img.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(PUBLIC_ICONS, 'icon-512.png'))
img.resize((192, 192), Image.Resampling.LANCZOS).save(os.path.join(PUBLIC_ICONS, 'icon-192.png'))
img.resize((180, 180), Image.Resampling.LANCZOS).save(os.path.join(PUBLIC_ICONS, 'apple-touch-icon.png'))
img.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(PUBLIC_ICONS, 'favicon-32.png'))

# Maskable icon keeps the important content inside the safe zone.
maskable = Image.new('RGBA', (512, 512), (8, 20, 34, 255))
inner = img.resize((410, 410), Image.Resampling.LANCZOS)
maskable.alpha_composite(inner, (51, 51))
maskable.save(os.path.join(PUBLIC_ICONS, 'icon-maskable-512.png'))

sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [img.resize((s, s), Image.Resampling.LANCZOS) for s in sizes]
frames[-1].save(os.path.join(ASSETS, 'icon.ico'), format='ICO', sizes=[(s, s) for s in sizes])
img.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(ASSETS, 'tray.png'))
img.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(ASSETS, 'tray.ico'), format='ICO', sizes=[(16, 16), (32, 32)])

print('icon generated')
