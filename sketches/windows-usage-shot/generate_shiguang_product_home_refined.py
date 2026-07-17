from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import textwrap

W, H = 1600, 980
img = Image.new('RGBA', (W, H), '#eef2f7')
d = ImageDraw.Draw(img)

for y in range(H):
    t = y / H
    r = int(241 - 10 * t)
    g = int(243 - 8 * t)
    b = int(247 - 7 * t)
    d.line((0, y, W, y), fill=(r, g, b, 255))


def glow(cx, cy, r, color, blur=86):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


glow(1310, 860, 290, (78, 175, 255, 52))
glow(1240, 900, 200, (78, 222, 177, 46))
glow(350, 120, 180, (124, 102, 255, 34), 72)

font_path = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
def fb(size): return ImageFont.truetype(font_path, size)
def fr(size): return ImageFont.truetype(font_path, size)

WHITE = (245, 247, 250, 255)
SOFT = (214, 218, 226, 255)
MUTED = (128, 135, 146, 255)
DIM = (103, 109, 120, 255)
LINE = (53, 56, 63, 255)
PANEL = (28, 29, 34, 255)
PANEL_2 = (24, 25, 30, 255)
PANEL_3 = (33, 35, 41, 255)
ACCENT = (122, 98, 255, 255)
BLUE = (86, 136, 255, 255)
GREEN = (81, 200, 156, 255)
ORANGE = (255, 155, 84, 255)


def rounded(box, radius, fill, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def pill(x, y, label, fill, outline, text_fill, pad_x=12, h=28, font=None):
    font = font or fr(11)
    tw = d.textbbox((0, 0), label, font=font)[2]
    rounded((x, y, x + tw + pad_x * 2, y + h), h // 2, fill, outline)
    d.text((x + pad_x, y + 7), label, font=font, fill=text_fill)
    return x + tw + pad_x * 2


def card_shadow(box, radius=24, alpha=120, blur=18):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle(box, radius=radius, fill=(0, 0, 0, alpha))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


# outer browser shell
rounded((56, 42, 1544, 938), 24, (250, 250, 252, 255), (219, 223, 230, 255))
rounded((56, 42, 1544, 104), 24, (247, 248, 251, 255), (219, 223, 230, 255))
for i, col in enumerate([(255, 95, 87), (255, 189, 46), (40, 201, 64)]):
    d.ellipse((82 + i * 24, 63, 94 + i * 24, 75), fill=col)
rounded((182, 57, 946, 89), 14, (255, 255, 255, 255), (223, 226, 233, 255))
d.text((208, 66), 'shiguang://workspace/home?view=desktop', font=fr(11), fill=(134, 140, 151, 255))
d.text((1460, 64), '⋯', font=fb(20), fill=(114, 120, 131, 255))

# main app shell
app = (142, 122, 1426, 892)
card_shadow(app, radius=30, alpha=150, blur=28)
rounded(app, 30, (19, 20, 24, 252), (44, 47, 54, 255))
rounded((142, 122, 1426, 170), 30, (23, 24, 28, 255))
d.line((142, 170, 1426, 170), fill=(43, 46, 52, 255), width=1)

# title bar
rounded((164, 133, 196, 159), 10, (122, 98, 255, 255))
d.text((180, 139), '拾', font=fb(14), fill=WHITE, anchor='mm')
d.text((212, 139), '拾光 Agent', font=fb(18), fill=WHITE)
d.text((330, 142), '桌面工作台', font=fr(12), fill=MUTED)

mx = 980
for label in ['会话', '来源', '产物', '设置']:
    d.text((mx, 141), label, font=fr(12), fill=(170, 175, 183, 255))
    mx += 58
for i, sym in enumerate(['—', '□', '✕']):
    rounded((1302 + i * 34, 136, 1330 + i * 34, 158), 8, (34, 36, 42, 255))
    d.text((1312 + i * 34, 141), sym, font=fr(11), fill=(188, 193, 201, 255))

# 3-column layout
sidebar = (160, 186, 446, 872)
center = (468, 186, 1058, 872)
right = (1078, 186, 1408, 872)
rounded(sidebar, 0, (22, 23, 28, 255))
rounded(center, 0, (24, 25, 30, 255))
rounded(right, 0, (24, 25, 30, 255))
d.line((446, 186, 446, 872), fill=(41, 44, 50, 255), width=1)
d.line((1058, 186, 1058, 872), fill=(41, 44, 50, 255), width=1)

# sidebar workspace card
rounded((178, 202, 428, 290), 18, (31, 33, 39, 255), LINE)
card_shadow((178, 202, 428, 290), radius=18, alpha=58, blur=10)
d.ellipse((198, 220, 242, 264), fill=ACCENT)
d.text((220, 227), '拾', font=fb(18), fill=WHITE, anchor='mm')
d.text((258, 220), '当前工作区', font=fr(11), fill=MUTED)
d.text((258, 243), '拾光产品实验室', font=fb(15), fill=WHITE)
d.text((258, 265), 'DeepSeek 默认 · 7 个来源在线', font=fr(10), fill=DIM)

# sidebar nav
nav = [('✚', '新建对话'), ('◷', '待处理'), ('⌘', '技能'), ('⌂', '来源'), ('⧉', '产物'), ('☰', '历史')]
y = 320
for idx, (icon, label) in enumerate(nav):
    if idx == 1:
        rounded((176, y - 8, 428, y + 22), 12, (35, 37, 44, 255))
    d.text((194, y), icon, font=fr(14), fill=(153, 159, 168, 255))
    d.text((224, y - 1), label, font=fr(14), fill=WHITE if idx == 1 else SOFT)
    if idx == 1:
        pill(374, y - 6, '2', (72, 60, 116, 255), None, (215, 205, 255, 255), pad_x=9, h=22, font=fr(10))
    y += 38

# sidebar quick actions
rounded((178, 568, 428, 650), 18, (29, 31, 36, 255), LINE)
d.text((194, 586), '快速入口', font=fb(12), fill=MUTED)
quick = ['查看待审批项目', '打开最近产物', '切换默认模型']
qy = 610
for text in quick:
    rounded((194, qy - 6, 412, qy + 18), 10, (35, 37, 43, 255))
    d.text((208, qy), text, font=fr(12), fill=SOFT)
    qy += 28

# sidebar groups
rounded((178, 666, 428, 796), 18, (29, 31, 36, 255), LINE)
d.text((194, 684), '会话分组', font=fb(12), fill=MUTED)
groups = [
    ('拾光 Agent 首页', True),
    ('运行中任务', False),
    ('待审批工具调用', False),
    ('来源接入与授权', False),
    ('产物导出与跳转', False),
]
gy = 712
for label, active in groups:
    if active:
        rounded((190, gy - 6, 414, gy + 20), 10, (38, 40, 47, 255))
    d.text((206, gy), label, font=fr(12), fill=WHITE if active else SOFT)
    gy += 26

rounded((178, 814, 428, 854), 14, (29, 31, 36, 255))
d.ellipse((194, 822, 222, 850), fill=GREEN)
d.text((236, 825), '本地桌面实例', font=fb(13), fill=WHITE)
d.text((236, 841), '运行正常 · 时间线在线', font=fr(10), fill=DIM)

# center area
# top chips
pill(492, 210, '待审批 2', (45, 39, 32, 255), (91, 74, 46, 255), (255, 212, 150, 255))
pill(606, 210, '运行中 5', (31, 39, 50, 255), (58, 79, 114, 255), (188, 214, 255, 255))
pill(720, 210, '可见产物 18', (31, 43, 39, 255), (48, 85, 73, 255), (186, 248, 221, 255))

# hero
hero_box = (490, 246, 1034, 392)
rounded(hero_box, 26, (27, 29, 35, 255), LINE)
card_shadow(hero_box, radius=26, alpha=62, blur=14)
grad = Image.new('RGBA', (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
gd.rounded_rectangle(hero_box, radius=26, fill=(255, 255, 255, 0))
gd.ellipse((850, 236, 1100, 486), fill=(87, 134, 255, 34))
gd.ellipse((740, 220, 960, 440), fill=(126, 102, 255, 26))
img.alpha_composite(grad.filter(ImageFilter.GaussianBlur(20)))
d.text((522, 278), '拾光 Agent 首页', font=fr(12), fill=MUTED)
d.text((522, 314), '今天想让拾光 Agent 帮你推进什么？', font=fb(29), fill=WHITE)
d.text((522, 350), '从会话、来源、产物到审批流，首页直接进入真实工作，不再只是聊天壳子。', font=fr(14), fill=(156, 163, 173, 255))
pill(522, 366, '工作入口', (48, 42, 86, 255), None, (218, 208, 255, 255), h=26, font=fr(10))
pill(620, 366, '可见状态', (33, 43, 53, 255), None, (191, 213, 255, 255), h=26, font=fr(10))
pill(718, 366, '可跳转产物', (34, 45, 41, 255), None, (186, 248, 221, 255), h=26, font=fr(10))

# action cards
cards = [
    ('▶', '继续上次任务', '恢复最近运行中的会话，继续计划、工具链和上下文。', BLUE),
    ('⌂', '接入来源与仓库', '连接 GitHub、目录、网页或 MCP，让上下文立即可用。', ACCENT),
    ('✓', '处理待审批动作', '集中查看终端、浏览器、写文件等等待批准的步骤。', GREEN),
    ('↗', '查看产物与跳转', '直接打开截图、页面、文档和差异，不把结果埋在聊天里。', ORANGE),
]
card_w, card_h = 254, 146
sx, sy = 490, 424
for i, (icon, title, desc, col) in enumerate(cards):
    x = sx + (i % 2) * (card_w + 22)
    y0 = sy + (i // 2) * (card_h + 20)
    box = (x, y0, x + card_w, y0 + card_h)
    rounded(box, 20, PANEL_3, LINE)
    card_shadow(box, radius=20, alpha=60, blur=12)
    d.ellipse((x + 18, y0 + 18, x + 52, y0 + 52), fill=col)
    d.text((x + 35, y0 + 26), icon, font=fr(15), fill=WHITE, anchor='mm')
    d.text((x + 18, y0 + 68), title, font=fb(15), fill=WHITE)
    for j, line in enumerate(textwrap.wrap(desc, width=15)[:2]):
        d.text((x + 18, y0 + 94 + j * 16), line, font=fr(11), fill=(151, 157, 167, 255))
    d.text((x + 18, y0 + 124), '立即进入', font=fr(10), fill=MUTED)

# bottom composer + workbench strips
rounded((490, 756, 548, 818), 18, (31, 33, 39, 255), LINE)
d.text((508, 775), '最新焦点', font=fr(11), fill=MUTED)
d.text((508, 796), '桌面首页产品化', font=fb(15), fill=WHITE)
rounded((560, 756, 706, 818), 18, (31, 33, 39, 255), LINE)
d.text((578, 775), '最近产物', font=fr(11), fill=MUTED)
d.text((578, 796), '3 张截图', font=fb(15), fill=WHITE)
rounded((718, 756, 878, 818), 18, (31, 33, 39, 255), LINE)
d.text((736, 775), '待审批', font=fr(11), fill=MUTED)
d.text((736, 796), '终端 / 发布', font=fb(15), fill=WHITE)
rounded((890, 756, 1034, 818), 18, (31, 33, 39, 255), LINE)
d.text((908, 775), '在线来源', font=fr(11), fill=MUTED)
d.text((908, 796), 'GitHub / MCP', font=fb(15), fill=WHITE)

rounded((490, 830, 1034, 862), 16, (28, 30, 35, 255))
d.text((508, 839), '例如：继续处理待审批的终端步骤，并把最新产物直接挂到右侧。', font=fr(12), fill=DIM)

# right inspector: realistic runtime homepage blocks
# approvals
rounded((1098, 206, 1388, 354), 20, (30, 31, 37, 255), LINE)
d.text((1120, 226), '待审批动作', font=fb(15), fill=WHITE)
pill(1282, 222, '2 项等待', (76, 58, 32, 255), None, (255, 214, 156, 255), h=24, font=fr(10))
rounded((1120, 254, 1366, 300), 14, (40, 36, 31, 255), (93, 75, 49, 255))
d.text((1138, 271), '终端打包验证', font=fb(13), fill=WHITE)
d.text((1138, 289), '等待批准后导出 Windows 构建截图', font=fr(10), fill=MUTED)
d.text((1318, 272), '批准 →', font=fr(11), fill=(255, 214, 156, 255))
rounded((1120, 308, 1366, 336), 12, (35, 37, 43, 255))
d.text((1138, 317), '页面发布到演示位', font=fr(11), fill=SOFT)
d.text((1298, 317), '查看', font=fr(11), fill=(189, 213, 255, 255))

# artifacts
rounded((1098, 372, 1388, 560), 20, (30, 31, 37, 255), LINE)
d.text((1120, 392), '最新产物', font=fb(15), fill=WHITE)
artifacts = [
    ('首页产品稿 PNG', '刚刚生成 · 可直接预览', (189, 213, 255, 255)),
    ('Codex 骨架稿', '上一轮版本 · 供对照', (208, 214, 223, 255)),
    ('HTML 单页原型', '浏览器打开 · 继续拖改', (186, 248, 221, 255)),
]
y = 424
for title, sub, col in artifacts:
    rounded((1120, y, 1366, y + 42), 13, (35, 37, 43, 255))
    d.text((1138, y + 10), title, font=fb(12), fill=WHITE)
    d.text((1138, y + 26), sub, font=fr(10), fill=MUTED)
    d.text((1306, y + 16), '打开 ↗', font=fr(10), fill=col)
    y += 50

# sources
rounded((1098, 578, 1388, 714), 20, (30, 31, 37, 255), LINE)
d.text((1120, 598), '来源状态', font=fb(15), fill=WHITE)
sources = [
    ('GitHub 仓库', '已连接', GREEN),
    ('Browser / 页面验证', '在线', BLUE),
    ('本地文件系统', '可读写', SOFT),
    ('MCP 服务', '2 个可用', (212, 197, 255, 255)),
]
y = 628
for title, status, col in sources:
    d.ellipse((1122, y + 6, 1132, y + 16), fill=col)
    d.text((1142, y), title, font=fr(11), fill=SOFT)
    d.text((1316, y), status, font=fr(11), fill=col)
    y += 22

# operator focus
rounded((1098, 732, 1388, 854), 20, (30, 31, 37, 255), LINE)
d.text((1120, 752), '当前焦点', font=fb(15), fill=WHITE)
focus = [
    ('会话', '桌面首页产品化'),
    ('最新动作', '已补齐右侧真实状态区'),
    ('下一步', '继续细抠图标与间距'),
]
y = 782
for k, v in focus:
    d.text((1120, y), k, font=fr(11), fill=MUTED)
    d.text((1202, y), v, font=fr(11), fill=SOFT)
    y += 22

out = Path('/home/ubuntu/shiguang-agent/sketches/windows-usage-shot/shiguang-agent-product-home-refined.png')
out.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(out, quality=96)
print(out)
