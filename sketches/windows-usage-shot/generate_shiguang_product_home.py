from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import textwrap

W, H = 1600, 980
img = Image.new('RGBA', (W, H), '#eff2f7')
d = ImageDraw.Draw(img)

for y in range(H):
    t = y / H
    r = int(241 - 9 * t)
    g = int(243 - 8 * t)
    b = int(248 - 6 * t)
    d.line((0, y, W, y), fill=(r, g, b, 255))


def blur_ellipse(cx, cy, r, color, blur=80):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


blur_ellipse(1360, 860, 280, (88, 170, 255, 52))
blur_ellipse(1280, 920, 220, (82, 220, 177, 46))
blur_ellipse(320, 140, 200, (120, 99, 255, 32), 72)

font_path = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
def fb(size): return ImageFont.truetype(font_path, size)
def fr(size): return ImageFont.truetype(font_path, size)


def rounded(box, radius, fill, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


# browser shell
rounded((58, 44, 1540, 936), 24, (250, 250, 252, 255), (218, 221, 228, 255))
rounded((58, 44, 1540, 104), 24, (247, 248, 251, 255), (218, 221, 228, 255))
for i, col in enumerate([(255, 95, 87), (255, 189, 46), (40, 201, 64)]):
    x = 84 + i * 24
    d.ellipse((x, 64, x + 12, 76), fill=col)
rounded((180, 58, 928, 88), 14, (255, 255, 255, 255), (223, 226, 233, 255))
d.text((206, 66), 'shiguang://workspace/desktop-home', font=fr(11), fill=(132, 139, 151, 255))
d.text((1440, 65), '⋯', font=fb(20), fill=(116, 123, 135, 255))

# main dark shell
app = (154, 126, 1418, 886)
shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle(app, radius=28, fill=(0, 0, 0, 172))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26)))
rounded(app, 28, (20, 21, 25, 252), (45, 48, 55, 255))

rounded((154, 126, 1418, 172), 28, (24, 25, 29, 255))
d.line((154, 172, 1418, 172), fill=(44, 46, 53, 255), width=1)
d.text((184, 142), '拾光 Agent', font=fb(18), fill=(246, 247, 250, 255))
d.text((300, 143), '桌面工作台', font=fr(12), fill=(146, 151, 160, 255))

menus = ['会话', '来源', '产物', '设置']
mx = 994
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

# sidebar brand
rounded((188, 204, 454, 276), 16, (30, 31, 37, 255), (49, 52, 60, 255))
d.ellipse((206, 222, 246, 262), fill=(125, 94, 255, 255))
d.text((226, 229), '拾', font=fb(18), fill=(255, 255, 255, 255), anchor='mm')
d.text((262, 222), '当前工作区', font=fr(11), fill=(131, 137, 147, 255))
d.text((262, 242), '拾光产品实验室', font=fb(15), fill=(246, 247, 250, 255))
d.text((262, 262), 'DeepSeek 默认 · 7 个来源在线', font=fr(10), fill=(122, 127, 137, 255))

items_primary = [
    ('✚', '新建对话'), ('◷', '待处理'), ('⌘', '技能'), ('⌂', '来源'), ('⧉', '产物'), ('☰', '历史')
]
y = 306
for icon, label in items_primary:
    d.text((198, y), icon, font=fr(14), fill=(152, 157, 167, 255))
    d.text((228, y - 1), label, font=fr(14), fill=(230, 233, 238, 255))
    y += 36

subitems = ['查看待审批项目', '打开最近产物']
y += 10
for label in subitems:
    rounded((194, y - 4, 444, y + 22), 10, (31, 32, 38, 255))
    d.text((210, y + 1), label, font=fr(12), fill=(183, 188, 198, 255))
    y += 34

d.text((194, y + 18), '会话分组', font=fb(12), fill=(124, 129, 139, 255))
y += 52
rounded((186, y, 454, y + 40), 12, (35, 36, 43, 255))
d.text((202, y + 11), '拾光 Agent 首页', font=fb(14), fill=(248, 249, 251, 255))
d.text((422, y + 11), '⌄', font=fr(12), fill=(142, 147, 156, 255))
y += 52
project_items = [
    '运行中任务',
    '待审批工具调用',
    '来源接入与授权',
    '模型与 Provider 配置',
    '产物导出与跳转',
    '桌面截图与演示',
]
for idx, label in enumerate(project_items):
    if idx == 0:
        rounded((190, y - 4, 450, y + 24), 10, (38, 39, 46, 255))
    d.text((208, y), label, font=fr(12), fill=(198, 202, 209, 255))
    y += 32

d.text((194, y + 10), '小说创作', font=fr(13), fill=(216, 220, 226, 255))
d.text((208, y + 34), '独立大任务组', font=fr(12), fill=(123, 128, 137, 255))

rounded((186, 810, 454, 850), 12, (29, 30, 36, 255))
d.ellipse((200, 818, 228, 846), fill=(78, 212, 166, 255))
d.text((238, 822), '本地桌面实例', font=fb(13), fill=(236, 238, 241, 255))
d.text((238, 838), '运行正常 · 时间线在线', font=fr(10), fill=(129, 134, 143, 255))

# center product homepage
stat_titles = [('待审批', '2'), ('运行中', '5'), ('可见产物', '18')]
start_sx = 570
for idx, (title, val) in enumerate(stat_titles):
    x = start_sx + idx * 152
    rounded((x, 216, x + 136, 278), 16, (31, 33, 39, 255), (52, 55, 63, 255))
    d.text((x + 18, 232), title, font=fr(11), fill=(133, 139, 149, 255))
    d.text((x + 18, 252), val, font=fb(24), fill=(244, 246, 248, 255))

prompt = '今天想让拾光 Agent 帮你推进什么？'
d.text((950, 330), prompt, font=fb(30), fill=(244, 245, 248, 255), anchor='mm')
d.text((950, 364), '从会话、来源、产物到审批流，直接从首页进入真实工作。', font=fr(14), fill=(131, 137, 147, 255), anchor='mm')

cards = [
    ('◉', '继续上次任务', '恢复最近运行中的会话，继续执行计划与工具链。', (89, 128, 255)),
    ('◎', '接入来源与仓库', '连接 GitHub、目录、网页或 MCP，让上下文立即可用。', (108, 86, 255)),
    ('✓', '处理待审批动作', '集中查看终端、浏览器、写文件等等待批准的步骤。', (77, 170, 132)),
    ('↗', '查看产物与跳转', '直接打开截图、页面、文档和代码差异，不埋在聊天里。', (255, 149, 86)),
]
card_w, card_h = 250, 136
gap = 24
start_x = 560
start_y = 412
for i, (icon, title, desc, col) in enumerate(cards):
    x = start_x + (i % 2) * (card_w + gap)
    y0 = start_y + (i // 2) * (card_h + 24)
    rounded((x, y0, x + card_w, y0 + card_h), 18, (31, 33, 39, 255), (54, 57, 65, 255))
    d.ellipse((x + 18, y0 + 18, x + 46, y0 + 46), fill=(*col, 255))
    d.text((x + 32, y0 + 24), icon, font=fr(14), fill=(255, 255, 255, 255), anchor='mm')
    d.text((x + 18, y0 + 60), title, font=fb(15), fill=(242, 244, 247, 255))
    for j, line in enumerate(textwrap.wrap(desc, width=15)[:2]):
        d.text((x + 18, y0 + 86 + j * 16), line, font=fr(11), fill=(147, 153, 163, 255))

rounded((1098, 412, 1336, 572), 18, (29, 31, 36, 255), (54, 57, 65, 255))
d.text((1120, 432), '当前焦点', font=fb(14), fill=(243, 245, 248, 255))
focus_rows = [
    ('会话', '桌面首页产品化'),
    ('最新动作', '已生成 Codex 骨架稿'),
    ('下一步', '改成拾光 Agent 自身首页'),
    ('状态', '设计中'),
]
y = 460
for k, v in focus_rows:
    d.text((1120, y), k, font=fr(11), fill=(124, 130, 140, 255))
    d.text((1206, y), v, font=fr(11), fill=(223, 226, 232, 255))
    y += 24

rounded((560, 712, 782, 752), 14, (30, 31, 37, 255), (54, 57, 65, 255))
d.text((578, 726), '最近产物  3 张截图 · 2 个 HTML 原型', font=fr(12), fill=(171, 176, 184, 255))
rounded((794, 712, 1038, 752), 14, (30, 31, 37, 255), (54, 57, 65, 255))
d.text((812, 726), '待审批  终端打包验证 / 页面发布', font=fr(12), fill=(171, 176, 184, 255))
rounded((1050, 712, 1338, 752), 14, (30, 31, 37, 255), (54, 57, 65, 255))
d.text((1068, 726), '在线来源  GitHub / 文件 / Browser / MCP', font=fr(12), fill=(171, 176, 184, 255))

rounded((560, 776, 1342, 840), 22, (29, 30, 35, 255), (56, 58, 67, 255))
d.text((592, 801), '比如：继续处理待审批的终端步骤，并把最新产物直接挂到右侧。', font=fr(15), fill=(124, 130, 140, 255))
rounded((1268, 788, 1302, 828), 12, (40, 41, 47, 255), (60, 62, 70, 255))
d.text((1280, 798), '+', font=fb(18), fill=(214, 217, 223, 255))
d.text((1320, 798), '→', font=fr(18), fill=(171, 176, 184, 255))

d.text((566, 852), '首页不是聊天壳子，而是工作入口：继续任务 / 审批 / 来源 / 产物 四件事一眼可达。', font=fr(12), fill=(111, 117, 128, 255))

out = Path('/home/ubuntu/shiguang-agent/sketches/windows-usage-shot/shiguang-agent-product-home-codex-bones.png')
out.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(out, quality=96)
print(out)
