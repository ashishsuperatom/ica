#!/usr/bin/env python3
"""Contact sheets for reading a run by eye: per page, its widths side by side (scaled to one height), the issues
marked. Usage: python3 scripts/ui-review/sheets.py <run dir>  → <run dir>/sheets/<page>.png"""
import json, os, sys
from PIL import Image, ImageDraw

run = sys.argv[1]
report = json.load(open(os.path.join(run, 'report.json')))['report']
out = os.path.join(run, 'sheets'); os.makedirs(out, exist_ok=True)
H = 900  # every shot scaled to this height (desktop 900 stays 1:1)
pages = {}
for e in report: pages.setdefault(e['page'], []).append(e)
for page, shots in pages.items():
    imgs = []
    for e in shots:
        im = Image.open(os.path.join(run, e['shot'])).convert('RGB')
        d = ImageDraw.Draw(im)
        for i in e['issues']:
            a = i.get('at')
            if a: d.rectangle([a['x'], a['y'], a['x'] + max(6, a['w']), a['y'] + max(6, a['h'])], outline=(217, 45, 32), width=3)
        s = H / im.height
        imgs.append(im.resize((int(im.width * s), H)))
    sheet = Image.new('RGB', (sum(i.width for i in imgs) + 24 * (len(imgs) - 1), H), (40, 40, 40))
    x = 0
    for i in imgs: sheet.paste(i, (x, 0)); x += i.width + 24
    sheet.save(os.path.join(out, f'{page}.png'))
print(out)
