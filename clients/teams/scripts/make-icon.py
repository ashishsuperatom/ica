#!/usr/bin/env python3
# Generate a Teams app icon pair for a project: a filled color tile + a transparent outline mark,
# both carrying a short 2-char label (e.g. "F5", "TG"). Keeps every project's icons on-brand + distinct.
#   python3 make-icon.py <label> <accent-hex> <out-dir>
import sys, os
from PIL import Image, ImageDraw, ImageFont

label, accent, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
rgb = tuple(int(accent.lstrip('#')[i:i+2], 16) for i in (0, 2, 4))

FONTS = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
         "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNSRounded.ttf",
         "/System/Library/Fonts/SFNS.ttf"]
def font(sz):
    for p in FONTS:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, sz)
            except Exception: pass
    return ImageFont.load_default()
def centered(img, text, f, fill):
    d = ImageDraw.Draw(img); W, H = img.size
    b = d.textbbox((0, 0), text, font=f); w = b[2]-b[0]; h = b[3]-b[1]
    d.text(((W-w)/2 - b[0], (H-h)/2 - b[1]), text, font=f, fill=fill)

# color.png — 192×192 filled brand tile, white label
c = Image.new("RGBA", (192, 192), rgb + (255,))
centered(c, label, font(92 if len(label) <= 2 else 72), (255, 255, 255, 255))
c.save(os.path.join(out, "color.png"))
# outline.png — 32×32 transparent, single-color (white) label
o = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
centered(o, label, font(19 if len(label) <= 2 else 15), (255, 255, 255, 255))
o.save(os.path.join(out, "outline.png"))
print(f"icons for {label}: {os.path.join(out,'color.png')} (192) + outline (32)")
