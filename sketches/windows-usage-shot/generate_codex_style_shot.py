from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import textwrap

W, H = 1600, 980
img = Image.new('RGBA', (W, H), '#f1f3f7')
d = ImageDraw.Draw(img)

# soft desktop background
for y in range(H):
    t = y / H
    shade = int(242 - 10 * t)
    d.line((0, y, W, y), fill=(shade, shade + 1, shade + 4, 255))

def blur_ellipse(cx, cy, r, color, blur=70):
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((cx-r, cy-r, cx+r, cy+r), fill=color)
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(blur)))

blur_ellipse(1470, 880, 240, (80, 178, 255, 60), 80)
blur_ellipse(1380, 930, 200, (114, 214, 170, 55), 85)
blur_ellipse(280, 120, 180, (98, 87, 255, 34), 70)

font_path = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
def fb(size): return ImageFont.truetype(font_path, size)
def fr(size): return ImageFont.truetype(font_path, size)

def rounded(box, radius, fill, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

# Browser/backdrop hint
rounded((58, 44, 1540, 936), 24, (250, 250, 252, 255), (218, 221, 228, 255))
rounded((58, 44, 1540, 104), 24, (247, 248, 251, 255), (218, 221, 228, 255))
for i, col in enumerate([(255, 95, 87), (255, 189, 46), (40, 201, 64)]):
    x = 84 + i * 24
    d.ellipse((x, 64, x + 12, 76), fill=col)
rounded((180, 58, 900, 88), 14, (255, 255, 255, 255), (223, 226, 233, 255))
d.text((206, 66), 'https://portswigger.example/web-security-academy', font=fr(11), fill=(132, 139, 151, 255))
d.text((1440, 65), '⋯', font=fb(20), fill=(116, 123, 135, 255))

# Main dark app shell
app = (154, 126, 1418, 886)
shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle(app, radius=28, fill=(0, 0, 0, 170))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26)))
rounded(app, 28, (20, 21, 24, 252), (46, 49, 56, 255))

ax1, ay1, ax2, ay2 = app
# top bar
rounded((154, 126, 1418, 172), 28, (24, 25, 29, 255))
d.line((154, 172, 1418, 172), fill=(44, 46, 53, 255), width=1)
d.text((184, 142), 'ChatGPT Codex', font=fb(18), fill=(246, 247, 250, 255))

# app window controls/menu
menus = ['文件', '编辑', '视图', '帮助']
mx = 980
for label in menus:
    d.text((mx, 143), label, font=fr(12), fill=(166, 171, 179, 255))
    mx += 54
for i, sym in enumerate(['—', '□', '✕']):
    rounded((1298 + i * 34, 138, 1326 + i * 34, 160), 8, (35, 36, 42, 255))
    d.text((1308 + i * 34, 143), sym, font=fr(11), fill=(186, 190, 198, 255))

# columns
sidebar = (172, 188, 472, 866)
content = (494, 188, 1400, 866)
rounded(sidebar, 0, (23, 24, 28, 255))
rounded(content, 0, (25, 26, 31, 255))
d.line((472, 188, 472, 866), fill=(42, 44, 50, 255), width=1)

# sidebar
items_primary = [
    ('✚', '新建任务'), ('◷', '已安排'), ('⌘', '插件'), ('⌂', '站点'), ('⑂', '拉取请求'), ('☰', '聊天')
]
y = 210
for icon, label in items_primary:
    d.text((198, y), icon, font=fr(14), fill=(152, 157, 167, 255))
    d.text((228, y-1), label, font=fr(14), fill=(230, 233, 238, 255))
    y += 36

# search-ish line block labels
subitems = ['查看三个链接', '查看共享聊天']
y += 12
for label in subitems:
    rounded((194, y-4, 444, y+22), 10, (31, 32, 38, 255))
    d.text((210, y+1), label, font=fr(12), fill=(183, 188, 198, 255))
    y += 34

d.text((194, y + 18), '项目', font=fb(12), fill=(124, 129, 139, 255))
y += 52
# active project
rounded((186, y, 454, y + 40), 12, (35, 36, 43, 255))
d.text((202, y + 11), 'codex日常', font=fb(14), fill=(248, 249, 251, 255))
d.text((422, y + 11), '⌄', font=fr(12), fill=(142, 147, 156, 255))
y += 52
project_items = [
    '查明原因',
    '查看 shiguang-agent-feature-t',
    '查找 Windows 11 位置',
    '定位 PHP 脚本输入方法',
    '了解 cobalt strike 用法',
    '展示思路',
]
for idx, label in enumerate(project_items):
    fill = (38, 39, 46, 255) if idx == 2 else (25, 26, 31, 255)
    if idx == 2:
        rounded((190, y - 4, 450, y + 24), 10, fill)
    d.text((208, y), label, font=fr(12), fill=(198, 202, 209, 255))
    y += 32

d.text((194, y + 10), 'New project 2', font=fr(13), fill=(216, 220, 226, 255))
d.text((208, y + 34), '无任务', font=fr(12), fill=(123, 128, 137, 255))

# user profile
rounded((186, 810, 454, 850), 12, (29, 30, 36, 255))
d.ellipse((200, 818, 228, 846), fill=(126, 94, 255, 255))
d.text((238, 822), 'Haozu XJ', font=fb(13), fill=(236, 238, 241, 255))
d.text((238, 838), '本地工作区', font=fr(10), fill=(129, 134, 143, 255))

# content area
# hero prompt
prompt = '我们应该在 codex 日常中做些什么?'
d.text((748, 298), prompt, font=fb(30), fill=(244, 245, 248, 255), anchor='mm')

# task cards
cards = [
    ('⌘', '探索并改进代码', '浏览代码结构，快速找到可优化的点。', (89, 128, 255)),
    ('🛠', '构建功能、应用或工具', '从任务描述直接起草实现与页面。', (108, 86, 255)),
    ('🛡', '审查代码并提升结构', '检查差异、质量风险和实现路径。', (77, 170, 132)),
    ('✦', '修复问题和失败', '聚焦报错、白屏、失败测试与异常链路。', (255, 149, 86)),
]
card_w, card_h = 236, 132
gap = 24
start_x = 566
start_y = 388
for i, (icon, title, desc, col) in enumerate(cards):
    x = start_x + (i % 2) * (card_w + gap)
    y0 = start_y + (i // 2) * (card_h + 24)
    rounded((x, y0, x + card_w, y0 + card_h), 18, (31, 33, 39, 255), (54, 57, 65, 255))
    d.ellipse((x + 18, y0 + 18, x + 46, y0 + 46), fill=(*col, 255))
    d.text((x + 32, y0 + 24), icon, font=fr(14), fill=(255, 255, 255, 255), anchor='mm')
    d.text((x + 18, y0 + 60), title, font=fb(15), fill=(242, 244, 247, 255))
    for j, line in enumerate(textwrap.wrap(desc, width=14)[:2]):
        d.text((x + 18, y0 + 86 + j * 16), line, font=fr(11), fill=(147, 153, 163, 255))

# input bar
rounded((560, 692, 1342, 756), 22, (29, 30, 35, 255), (56, 58, 67, 255))
d.text((592, 716), '随心输入', font=fr(16), fill=(124, 130, 140, 255))
rounded((1270, 704, 1304, 744), 12, (40, 41, 47, 255), (60, 62, 70, 255))
d.text((1282, 714), '+', font=fb(18), fill=(214, 217, 223, 255))
d.text((1322, 714), '🎤', font=fr(16), fill=(171, 176, 184, 255))

# subtle bottom note
rounded((560, 772, 1342, 814), 14, (26, 27, 32, 255))
d.text((586, 787), '建议：可以直接输入“做一个 Windows 11 首页截图，像 Codex 这样”', font=fr(12), fill=(111, 117, 128, 255))

out = Path('/home/ubuntu/shiguang-agent/sketches/windows-usage-shot/shiguang-agent-windows-usage-codex-zh.png')
out.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(out, quality=96)
print(out)
