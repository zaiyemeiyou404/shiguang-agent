from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import textwrap

W, H = 1600, 980
img = Image.new('RGBA', (W, H), '#0b0d12')
d = ImageDraw.Draw(img)

for y in range(H):
    t = y / H
    r = int(8 + (11 - 8) * t)
    g = int(9 + (12 - 9) * t)
    b = int(12 + (16 - 12) * t)
    d.line((0, y, W, y), fill=(r, g, b, 255))

for cx, cy, r, col in [
    (210, 90, 260, (131, 90, 255, 70)),
    (1350, 120, 220, (52, 132, 255, 50)),
    (930, 860, 300, (12, 170, 142, 28)),
]:
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col)
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(85)))

for x in range(0, W, 48):
    d.line((x, 0, x, H), fill=(255, 255, 255, 6))
for y in range(0, H, 48):
    d.line((0, y, W, y), fill=(255, 255, 255, 6))

font_path = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
font_b = lambda s: ImageFont.truetype(font_path, s)
font_r = lambda s: ImageFont.truetype(font_path, s)

border = (255, 255, 255, 22)
text = (244, 247, 251, 255)
text_soft = (200, 205, 218, 220)
text_dim = (160, 165, 178, 185)
accent = (140, 125, 255, 255)
accent_soft = (140, 125, 255, 38)
success = (87, 211, 166, 255)
warning = (248, 198, 98, 255)


def rounded(box, radius, fill, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


sidebar = (30, 30, 330, 950)
main = (346, 30, 1210, 950)
detail = (1226, 30, 1570, 950)

for box in [sidebar, main, detail]:
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(box, radius=26, fill=(0, 0, 0, 120))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
for box in [sidebar, main, detail]:
    rounded(box, 26, (20, 22, 29, 220), border)

# Sidebar
rounded((52, 52, 94, 94), 14, (159, 145, 255, 235))
d.text((64, 59), '拾', font=font_b(24), fill='white')
d.text((108, 57), '拾光 Agent', font=font_b(18), fill=text)
d.text((108, 80), 'Craft 风格 · 工作区收件箱', font=font_r(11), fill=text_dim)
rounded((274, 52, 312, 90), 12, (255, 255, 255, 12), border)
d.text((287, 60), '＋', font=font_b(18), fill=text_soft)

rounded((48, 118, 312, 240), 18, (255, 255, 255, 10), border)
accent_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ad = ImageDraw.Draw(accent_layer)
ad.rounded_rectangle((48, 118, 312, 240), radius=18, fill=accent_soft)
img.alpha_composite(accent_layer)
d.text((66, 136), '当前工作区', font=font_b(13), fill=text_soft)
d.text((250, 138), '远程 · 已同步', font=font_r(10), fill=text_dim)
d.text((66, 165), '拾光产品实验室', font=font_b(20), fill=text)
workspace_desc = '一个偏 Craft 风格的智能体工作台，强调会话、来源、产物和持续执行。'
for i, line in enumerate(textwrap.wrap(workspace_desc, width=24)):
    d.text((66, 194 + i * 18), line, font=font_r(11), fill=text_dim)
chips = [('● 默认模型 DeepSeek', accent), ('7 个来源', (220, 225, 235, 255)), ('12 个技能', (220, 225, 235, 255))]
cx, cy = 66, 223
for label, col in chips:
    tw = d.textbbox((0, 0), label, font=font_r(10))[2] + 20
    rounded((cx, cy, cx + tw, cy + 24), 12, (255, 255, 255, 10), (*col[:3], 70))
    d.text((cx + 10, cy + 6), label, font=font_r(10), fill=col)
    cx += tw + 8

rounded((48, 258, 312, 304), 18, (255, 255, 255, 10), border)
d.text((66, 275), '⌕', font=font_r(15), fill=text_dim)
d.text((92, 275), '搜索会话 / 产物 / 来源', font=font_r(12), fill=text_dim)
d.text((280, 275), '⌘K', font=font_r(10), fill=text_dim)

d.text((48, 332), '收件箱', font=font_b(16), fill=text)
d.text((268, 334), '8 个会话', font=font_r(10), fill=text_dim)

sessions = [
    ('严格工具配对', '把工具调用和工具结果严格按调用标识配对，旧事件再回退。', '进行中', 'active'),
    ('桌面截图润色', '把展示图改成真正接近 Craft 的桌面软件气质。', '评审中', 'normal'),
    ('产物与差异面板', '单个回合下展示工具调用、产物、差异和跳转入口。', '待办', 'normal'),
    ('来源接入规划', '统一 MCP / REST / 文件系统来源管理视图。', '自动', 'normal'),
]
y = 356
for title, preview, pill, kind in sessions:
    box = (48, y, 312, y + 96)
    fill = (255, 255, 255, 12) if kind == 'normal' else (140, 125, 255, 26)
    outline = border if kind == 'normal' else (140, 125, 255, 80)
    rounded(box, 18, fill, outline)
    d.text((64, y + 14), title, font=font_b(15), fill=text)
    pill_col = success if pill == '进行中' else warning if pill == '待办' else (200, 205, 218, 220)
    tw = d.textbbox((0, 0), pill, font=font_r(10))[2] + 16
    rounded((312 - tw - 14, y + 12, 298, y + 34), 11, (255, 255, 255, 10), (*pill_col[:3], 70))
    d.text((312 - tw - 6, y + 17), pill, font=font_r(10), fill=pill_col)
    for i, line in enumerate(textwrap.wrap(preview, width=24)[:2]):
        d.text((64, y + 42 + i * 16), line, font=font_r(11), fill=text_dim)
    d.text((64, y + 74), '刚刚更新', font=font_r(10), fill=text_dim)
    d.text((132, y + 74), '3 个产物', font=font_r(10), fill=text_dim)
    d.text((220, y + 74), '自动', font=font_r(10), fill=text_dim)
    y += 110

# Main panel
rounded((360, 44, 1196, 108), 18, (255, 255, 255, 9), border)
d.text((388, 59), '桌面截图润色', font=font_b(18), fill=text)
d.text((388, 82), '桌面式外壳 · 会话优先 · 产物可见 · 以来源为中心', font=font_r(11), fill=text_dim)
buttons = [('探索', False), ('请求修改', False), ('自动', True), ('分享', False)]
bx = 930
for label, primary in buttons:
    tw = d.textbbox((0, 0), label, font=font_r(11))[2] + 28
    rounded((bx, 58, bx + tw, 88), 12, (140, 125, 255, 28) if primary else (255, 255, 255, 10), (140, 125, 255, 80) if primary else border)
    d.text((bx + 14, 67), label, font=font_r(11), fill=text if primary else text_soft)
    bx += tw + 10

labels = ['＋ 新建对话', '产物', '来源', '技能', '时间线']
bx = 360
for label in labels:
    tw = d.textbbox((0, 0), label, font=font_r(11))[2] + 26
    rounded((bx, 124, bx + tw, 152), 12, (255, 255, 255, 10), border)
    d.text((bx + 13, 132), label, font=font_r(11), fill=text_soft)
    bx += tw + 8

stats = [('运行中的工具', '03'), ('上下文窗口', '48k'), ('产物', '12 个文件')]
bx = 360
for title_s, value in stats:
    rounded((bx, 166, bx + 150, 232), 16, (255, 255, 255, 10), border)
    d.text((bx + 16, 182), title_s, font=font_r(10), fill=text_dim)
    d.text((bx + 16, 202), value, font=font_b(20), fill=text)
    bx += 166

rounded((360, 248, 1196, 798), 22, (255, 255, 255, 7), border)


def message_card(box, who, time, body, fill=(255, 255, 255, 10), system=False):
    rounded(box, 18, fill, border)
    x1, y1, x2, y2 = box
    d.text((x1 + 18, y1 + 14), who, font=font_b(13), fill=text_soft if system else text)
    d.text((x2 - 58, y1 + 15), time, font=font_r(10), fill=text_dim)
    yy = y1 + 40
    for line in textwrap.wrap(body, width=48):
        d.text((x1 + 18, yy), line, font=font_r(13), fill=text_soft)
        yy += 18

message_card((384, 272, 1172, 344), '你', '11:45', '所有按钮显示都改成中文，完全汉化。', (140, 125, 255, 22))
message_card((384, 360, 1172, 468), '拾光 Agent', '11:46', '可以，直接把截图里的按钮、栏目名、状态词和说明文案全部换成中文。', (255, 255, 255, 10))
message_card((384, 484, 1172, 548), '实时事件', '11:47', '已读取 Craft 风格参考稿，准备输出完全汉化的桌面展示截图。', (255, 255, 255, 10), system=True)

rounded((384, 566, 1172, 774), 18, (255, 255, 255, 10), border)
d.text((404, 584), '最近一轮活动', font=font_b(14), fill=text)
subcards = [
    ('工具 · 读取', 'Craft 风格参考页', '确认现成视觉语言：面板、标签、会话卡片、详情块。'),
    ('工具 · 重绘', '当前展示截图', '把剩余英文按钮与栏目名全部改成中文，保留 Craft 的安静感。'),
]
sy = 616
for title1, title2, body in subcards:
    rounded((404, sy, 1152, sy + 64), 14, (255, 255, 255, 8), border)
    d.text((420, sy + 12), title1, font=font_r(10), fill=text_dim)
    d.text((520, sy + 12), title2, font=font_r(10), fill=text_dim)
    d.text((420, sy + 32), body, font=font_r(12), fill=text_soft)
    sy += 76

rounded((360, 814, 1196, 936), 22, (255, 255, 255, 8), border)
rounded((382, 836, 1174, 894), 16, (17, 19, 26, 255), border)
d.text((404, 854), '下一步把这张图再拆成 3 张真实产品截图：首页 / 运行中 / 待审批。', font=font_r(13), fill=text_soft)
labels = ['📎 添加文件', '@ 来源', '# 技能']
bx = 382
for label in labels:
    tw = d.textbbox((0, 0), label, font=font_r(11))[2] + 24
    rounded((bx, 904, bx + tw, 930), 12, (255, 255, 255, 10), border)
    d.text((bx + 12, 911), label, font=font_r(11), fill=text_dim)
    bx += tw + 10
rounded((1080, 902, 1174, 932), 14, (140, 125, 255, 28), (140, 125, 255, 80))
d.text((1116, 910), '发送', font=font_b(12), fill=text)

# Detail panel
rounded((1240, 48, 1556, 912), 22, (255, 255, 255, 7), border)
d.text((1262, 72), '会话详情', font=font_b(17), fill=text)
d.text((1458, 74), '当前工作区', font=font_r(10), fill=text_dim)
for box in [(1260, 104, 1536, 204), (1260, 220, 1536, 392), (1260, 408, 1536, 572), (1260, 588, 1536, 892)]:
    rounded(box, 18, (255, 255, 255, 10), border)

d.text((1278, 122), '运行快照', font=font_b(14), fill=text)
rows = [('模型', 'DeepSeek'), ('模式', '自动'), ('延迟', '1.2 秒'), ('令牌', '14.8k')]
y = 152
for k, v in rows:
    d.text((1278, y), k, font=font_r(11), fill=text_dim)
    d.text((1452, y), v, font=font_r(11), fill=text_soft)
    y += 20

d.text((1278, 238), '进度', font=font_b(14), fill=text)
d.text((1472, 240), '第 2 / 3 阶段', font=font_r(10), fill=text_dim)
progress = [('页面外壳', 1.0), ('运行态润色', 0.78), ('截图导出', 0.42)]
y = 274
for label, val in progress:
    d.text((1278, y), label, font=font_r(11), fill=text_soft)
    d.text((1488, y), f'{int(val * 100)}%', font=font_r(10), fill=text_dim)
    rounded((1278, y + 18, 1516, y + 28), 6, (255, 255, 255, 10), border)
    rounded((1278, y + 18, 1278 + int(238 * val), y + 28), 6, (140, 125, 255, 80))
    y += 42

d.text((1278, 414), '待审批', font=font_b(14), fill=text)
rounded((1278, 432, 1518, 548), 16, (248, 198, 98, 18), (248, 198, 98, 60))
d.text((1294, 450), '工具：终端', font=font_b(13), fill=text)
rounded((1426, 446, 1500, 468), 11, (248, 198, 98, 22), (248, 198, 98, 80))
d.text((1442, 451), '暂停中', font=font_r(10), fill=warning)
body = '等待确认是否执行打包验证，并导出最终桌面展示截图。'
for i, line in enumerate(textwrap.wrap(body, width=18)):
    d.text((1294, 476 + i * 16), line, font=font_r(11), fill=text_dim)
rounded((1294, 516, 1380, 540), 11, (255, 255, 255, 10), border)
rounded((1390, 516, 1476, 540), 11, (140, 125, 255, 28), (140, 125, 255, 80))
d.text((1320, 522), '拒绝', font=font_r(10), fill=text_dim)
d.text((1418, 522), '批准', font=font_r(10), fill=text)

d.text((1278, 606), '产物 / 来源', font=font_b(14), fill=text)
items = [
    ('PNG 展示图', '当前完全汉化版本'),
    ('界面参考', 'Craft 风格单页原型'),
    ('工作区', '演示工作区 · 已连接'),
    ('模型预设', '默认 DeepSeek · 备用 OpenAI'),
]
y = 640
for title_i, sub in items:
    rounded((1278, y, 1518, y + 52), 14, (255, 255, 255, 8), border)
    d.text((1294, y + 12), title_i, font=font_b(12), fill=text)
    d.text((1294, y + 30), sub, font=font_r(10), fill=text_dim)
    y += 64

out = Path('/home/ubuntu/shiguang-agent/sketches/windows-usage-shot/shiguang-agent-windows-usage-craft-zh.png')
out.parent.mkdir(parents=True, exist_ok=True)
img.convert('RGB').save(out, quality=96)
print(out)
