from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import textwrap

W, H = 1600, 980
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
RED = (255, 111, 111, 255)
YELLOW = (255, 198, 118, 255)

OUTDIR = Path('/home/ubuntu/shiguang-agent/sketches/windows-usage-shot')


def make_canvas():
    img = Image.new('RGBA', (W, H), '#eef2f7')
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        r = int(241 - 10 * t)
        g = int(243 - 8 * t)
        b = int(247 - 7 * t)
        d.line((0, y, W, y), fill=(r, g, b, 255))
    return img, d


def rounded(d, box, radius, fill, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def glow(img, cx, cy, r, color, blur=86):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def card_shadow(img, box, radius=24, alpha=120, blur=18):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle(box, radius=radius, fill=(0, 0, 0, alpha))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def pill(d, box, label, fill, text_fill, outline=None, font=None):
    font = font or fr(11)
    rounded(d, box, (box[3]-box[1]) // 2, fill, outline)
    d.text((box[0] + 12, box[1] + 7), label, font=font, fill=text_fill)


def draw_chrome(img, d, title, subtitle, active_nav, active_group, status_text):
    glow(img, 1310, 860, 290, (78, 175, 255, 52))
    glow(img, 1240, 900, 200, (78, 222, 177, 46))
    glow(img, 350, 120, 180, (124, 102, 255, 34), 72)

    rounded(d, (56, 42, 1544, 938), 24, (250, 250, 252, 255), (219, 223, 230, 255))
    rounded(d, (56, 42, 1544, 104), 24, (247, 248, 251, 255), (219, 223, 230, 255))
    for i, col in enumerate([(255, 95, 87), (255, 189, 46), (40, 201, 64)]):
        d.ellipse((82 + i * 24, 63, 94 + i * 24, 75), fill=col)
    rounded(d, (182, 57, 946, 89), 14, (255, 255, 255, 255), (223, 226, 233, 255))
    d.text((208, 66), f'shiguang://workspace/home?view={title}', font=fr(11), fill=(134, 140, 151, 255))
    d.text((1460, 64), '⋯', font=fb(20), fill=(114, 120, 131, 255))

    app = (142, 122, 1426, 892)
    card_shadow(img, app, radius=30, alpha=150, blur=28)
    rounded(d, app, 30, (19, 20, 24, 252), (44, 47, 54, 255))
    rounded(d, (142, 122, 1426, 170), 30, (23, 24, 28, 255))
    d.line((142, 170, 1426, 170), fill=(43, 46, 52, 255), width=1)

    rounded(d, (164, 133, 196, 159), 10, ACCENT)
    d.text((180, 139), '拾', font=fb(14), fill=WHITE, anchor='mm')
    d.text((212, 139), '拾光 Agent', font=fb(18), fill=WHITE)
    d.text((330, 142), subtitle, font=fr(12), fill=MUTED)

    mx = 980
    for label in ['会话', '来源', '产物', '设置']:
        d.text((mx, 141), label, font=fr(12), fill=(170, 175, 183, 255))
        mx += 58
    for i, sym in enumerate(['—', '□', '✕']):
        rounded(d, (1302 + i * 34, 136, 1330 + i * 34, 158), 8, (34, 36, 42, 255))
        d.text((1312 + i * 34, 141), sym, font=fr(11), fill=(188, 193, 201, 255))

    sidebar = (160, 186, 446, 872)
    center = (468, 186, 1058, 872)
    right = (1078, 186, 1408, 872)
    rounded(d, sidebar, 0, (22, 23, 28, 255))
    rounded(d, center, 0, (24, 25, 30, 255))
    rounded(d, right, 0, (24, 25, 30, 255))
    d.line((446, 186, 446, 872), fill=(41, 44, 50, 255), width=1)
    d.line((1058, 186, 1058, 872), fill=(41, 44, 50, 255), width=1)

    rounded(d, (178, 202, 428, 290), 18, (31, 33, 39, 255), LINE)
    card_shadow(img, (178, 202, 428, 290), radius=18, alpha=58, blur=10)
    d.ellipse((198, 220, 242, 264), fill=ACCENT)
    d.text((220, 227), '拾', font=fb(18), fill=WHITE, anchor='mm')
    d.text((258, 220), '当前工作区', font=fr(11), fill=MUTED)
    d.text((258, 243), '拾光产品实验室', font=fb(15), fill=WHITE)
    d.text((258, 265), status_text, font=fr(10), fill=DIM)

    nav = [('✦', '新建对话'), ('◷', '待处理'), ('⌘', '技能'), ('⌂', '来源'), ('⧉', '产物'), ('☰', '历史')]
    y = 320
    for idx, (icon, label) in enumerate(nav):
        if idx == active_nav:
            rounded(d, (176, y - 8, 428, y + 22), 12, (35, 37, 44, 255))
        d.text((194, y), icon, font=fr(14), fill=(153, 159, 168, 255))
        d.text((224, y - 1), label, font=fr(14), fill=WHITE if idx == active_nav else SOFT)
        if idx == active_nav:
            pill(d, (374, y - 6, 402, y + 16), '●', (72, 60, 116, 255), (215, 205, 255, 255), font=fr(9))
        y += 38

    rounded(d, (178, 568, 428, 650), 18, (29, 31, 36, 255), LINE)
    d.text((194, 586), '快速入口', font=fb(12), fill=MUTED)
    quick = ['查看待审批项目', '打开最近产物', '切换默认模型']
    qy = 610
    for text in quick:
        rounded(d, (194, qy - 6, 412, qy + 18), 10, (35, 37, 43, 255))
        d.text((208, qy), text, font=fr(12), fill=SOFT)
        qy += 28

    rounded(d, (178, 666, 428, 796), 18, (29, 31, 36, 255), LINE)
    d.text((194, 684), '会话分组', font=fb(12), fill=MUTED)
    groups = ['拾光 Agent 首页', '运行中任务', '待审批工具调用', '来源接入与授权', '产物导出与跳转']
    gy = 712
    for idx, label in enumerate(groups):
        active = idx == active_group
        if active:
            rounded(d, (190, gy - 6, 414, gy + 20), 10, (38, 40, 47, 255))
        d.text((206, gy), label, font=fr(12), fill=WHITE if active else SOFT)
        gy += 26

    rounded(d, (178, 814, 428, 854), 14, (29, 31, 36, 255))
    d.ellipse((194, 822, 222, 850), fill=GREEN)
    d.text((236, 825), '本地桌面实例', font=fb(13), fill=WHITE)
    d.text((236, 841), '运行正常 · 时间线在线', font=fr(10), fill=DIM)


def draw_home(img, d):
    draw_chrome(img, d, 'home', '桌面工作台', 1, 0, 'DeepSeek 默认 · 7 个来源在线')
    pill(d, (492, 210, 588, 236), '待审批 2', (45, 39, 32, 255), (255, 212, 150, 255), (91, 74, 46, 255))
    pill(d, (604, 210, 700, 236), '运行中 5', (31, 39, 50, 255), (188, 214, 255, 255), (58, 79, 114, 255))
    pill(d, (716, 210, 840, 236), '可见产物 18', (31, 43, 39, 255), (186, 248, 221, 255), (48, 85, 73, 255))

    hero_box = (490, 246, 1034, 392)
    rounded(d, hero_box, 26, (27, 29, 35, 255), LINE)
    card_shadow(img, hero_box, radius=26, alpha=62, blur=14)
    d.text((522, 278), '拾光 Agent 首页', font=fr(12), fill=MUTED)
    d.text((522, 314), '今天想让拾光 Agent 帮你推进什么？', font=fb(29), fill=WHITE)
    d.text((522, 350), '从会话、来源、产物到审批流，首页直接进入真实工作，不再只是聊天壳子。', font=fr(14), fill=(156, 163, 173, 255))

    cards = [
        ('▶', '继续上次任务', '恢复最近运行中的会话，继续计划、工具链和上下文。', BLUE),
        ('⌂', '接入来源与仓库', '连接 GitHub、目录、网页或 MCP，让上下文立即可用。', ACCENT),
        ('✓', '处理待审批动作', '集中查看终端、浏览器、写文件等等待批准的步骤。', GREEN),
        ('↗', '查看产物与跳转', '直接打开截图、页面、文档和差异，不把结果埋在聊天里。', ORANGE),
    ]
    draw_cards(img, d, cards)
    draw_home_bottom(d)
    draw_right_home(d)


def draw_running(img, d):
    draw_chrome(img, d, 'running', '执行工作台', 5, 1, 'Codex 骨架稿导出中 · 3 个来源在线')
    pill(d, (492, 210, 602, 236), '运行流活跃', (30, 44, 54, 255), (188, 214, 255, 255), (58, 79, 114, 255))
    pill(d, (618, 210, 722, 236), '工具 3 个', (31, 43, 39, 255), (186, 248, 221, 255), (48, 85, 73, 255))
    pill(d, (738, 210, 850, 236), '审批等待 1', (45, 39, 32, 255), (255, 212, 150, 255), (91, 74, 46, 255))

    rounded(d, (490, 246, 1034, 332), 22, (27, 29, 35, 255), LINE)
    d.text((522, 270), '运行中的任务', font=fr(12), fill=MUTED)
    d.text((522, 298), '桌面首页产品化 · 正在导出与验证', font=fb(26), fill=WHITE)

    lanes = ['全部 24', '对话 6', '工具 11', '审批 1', '错误 0']
    x = 490
    for idx, label in enumerate(lanes):
        fill = (39, 41, 48, 255) if idx == 2 else (31, 33, 39, 255)
        rounded(d, (x, 346, x + 92, 374), 14, fill, LINE)
        d.text((x + 14, 355), label, font=fr(10), fill=WHITE if idx == 2 else SOFT)
        x += 100

    # timeline blocks
    blocks = [
        ('11:48', '用户', '把首页做成更像真实可运行的桌面 Agent。', 'msg_user'),
        ('11:49', 'Agent', '收到，继续补右侧审批、产物、来源状态块，并统一视觉。', 'msg_agent'),
        ('11:50', '工具执行 · vision_analyze', '已对参考图完成比对，确认主骨架方向正确。', 'tool_done'),
        ('11:52', '工具执行 · write_file', '写入 refined 首页生成脚本 generate_shiguang_product_home_refined.py', 'tool_done'),
        ('11:53', '工具执行 · terminal', '正在运行 Python 脚本导出 PNG…', 'tool_live'),
        ('11:54', '工具执行 · vision_analyze', '已检查 refined 首页，确认具备产品稿质感与真实状态区。', 'tool_done'),
    ]
    y = 394
    for tm, head, body, kind in blocks:
        box = (490, y, 1034, y + (76 if kind.startswith('msg') else 68))
        fill = (38, 33, 53, 255) if kind == 'msg_user' else (32, 34, 40, 255)
        if kind == 'tool_done':
            fill = (30, 38, 36, 255)
        if kind == 'tool_live':
            fill = (31, 37, 48, 255)
        rounded(d, box, 18, fill, LINE)
        d.text((510, y + 14), head, font=fb(13), fill=WHITE)
        d.text((980, y + 14), tm, font=fr(10), fill=MUTED)
        for i, line in enumerate(textwrap.wrap(body, width=34)[:2]):
            d.text((510, y + 36 + i * 16), line, font=fr(12), fill=SOFT)
        if kind.startswith('tool'):
            col = GREEN if kind == 'tool_done' else BLUE
            d.ellipse((962, y + 42, 972, y + 52), fill=col)
            d.text((978, y + 39), '完成' if kind == 'tool_done' else '运行中', font=fr(10), fill=col)
        y += box[3] - box[1] + 12

    rounded(d, (490, 790, 1034, 862), 18, (28, 30, 35, 255), LINE)
    d.text((510, 810), '输入：继续导出第三张待审批页，并把可点击动作做得更强。', font=fr(13), fill=SOFT)
    d.text((510, 836), '状态：时间线实时订阅中，工具块已自动配对折叠。', font=fr(12), fill=DIM)
    draw_right_running(d)


def draw_approval(img, d):
    draw_chrome(img, d, 'approval', '审批工作台', 1, 2, '待审批动作 2 项 · 打包验证暂停')
    pill(d, (492, 210, 620, 236), '审批等待 2', (45, 39, 32, 255), (255, 212, 150, 255), (91, 74, 46, 255))
    pill(d, (636, 210, 742, 236), '阻塞任务 1', (54, 36, 36, 255), (255, 195, 195, 255), (109, 65, 65, 255))
    pill(d, (758, 210, 874, 236), '可立即处理', (31, 43, 39, 255), (186, 248, 221, 255), (48, 85, 73, 255))

    rounded(d, (490, 246, 1034, 346), 22, (27, 29, 35, 255), LINE)
    d.text((522, 270), '待审批中心', font=fr(12), fill=MUTED)
    d.text((522, 300), '有 2 个动作在等你点头继续', font=fb(28), fill=WHITE)
    d.text((522, 328), '把会影响系统状态、文件或发布的关键步骤集中展示，不让它们埋在消息里。', font=fr(13), fill=SOFT)

    approvals = [
        ('终端打包验证', '将运行桌面构建脚本并导出 Windows 风格发布图。', '预计 2–3 分钟', YELLOW),
        ('发布到演示位', '把当前 HTML 原型推到公开演示地址供浏览器验证。', '会产生外部可访问链接', ORANGE),
    ]
    y = 370
    for idx, (title, body, meta, col) in enumerate(approvals):
        box = (490, y, 1034, y + 132)
        rounded(d, box, 20, (32, 34, 40, 255), (93, 75, 49, 255) if idx == 0 else LINE)
        d.ellipse((514, y + 20, 550, y + 56), fill=col)
        d.text((532, y + 27), '!', font=fb(16), fill=(24, 24, 24, 255), anchor='mm')
        d.text((566, y + 24), title, font=fb(16), fill=WHITE)
        d.text((566, y + 50), body, font=fr(12), fill=SOFT)
        d.text((566, y + 74), meta, font=fr(11), fill=MUTED)
        rounded(d, (566, y + 92, 652, y + 118), 13, (41, 43, 49, 255), LINE)
        rounded(d, (664, y + 92, 764, y + 118), 13, (56, 42, 37, 255), (96, 74, 52, 255))
        rounded(d, (776, y + 92, 878, y + 118), 13, (35, 49, 42, 255), (56, 96, 76, 255))
        d.text((592, y + 99), '查看详情', font=fr(10), fill=SOFT)
        d.text((693, y + 99), '稍后处理', font=fr(10), fill=(255, 214, 156, 255))
        d.text((810, y + 99), '立即批准', font=fr(10), fill=(186, 248, 221, 255))
        y += 148

    rounded(d, (490, 686, 1034, 862), 18, (30, 31, 37, 255), LINE)
    d.text((510, 706), '审批说明', font=fb(14), fill=WHITE)
    notes = [
        '• 有副作用的动作统一进入这里，而不是只在聊天里一闪而过。',
        '• 每个审批卡片都能直接看影响范围、预计耗时和产出物。',
        '• 批准后，结果会回流到右侧产物区与运行时间线。',
    ]
    yy = 734
    for note in notes:
        d.text((510, yy), note, font=fr(12), fill=SOFT)
        yy += 28
    draw_right_approval(d)


def draw_cards(img, d, cards):
    card_w, card_h = 254, 146
    sx, sy = 490, 424
    for i, (icon, title, desc, col) in enumerate(cards):
        x = sx + (i % 2) * (card_w + 22)
        y0 = sy + (i // 2) * (card_h + 20)
        box = (x, y0, x + card_w, y0 + card_h)
        rounded(d, box, 20, PANEL_3, LINE)
        card_shadow(img, box, radius=20, alpha=60, blur=12)
        d.ellipse((x + 18, y0 + 18, x + 52, y0 + 52), fill=col)
        d.text((x + 35, y0 + 26), icon, font=fr(15), fill=WHITE, anchor='mm')
        d.text((x + 18, y0 + 68), title, font=fb(15), fill=WHITE)
        for j, line in enumerate(textwrap.wrap(desc, width=15)[:2]):
            d.text((x + 18, y0 + 94 + j * 16), line, font=fr(11), fill=(151, 157, 167, 255))
        d.text((x + 18, y0 + 124), '立即进入', font=fr(10), fill=MUTED)


def draw_home_bottom(d):
    items = [('最新焦点', '桌面首页产品化'), ('最近产物', '3 张截图'), ('待审批', '终端 / 发布'), ('在线来源', 'GitHub / MCP')]
    x = 490
    widths = [132, 146, 160, 144]
    for (title, value), w in zip(items, widths):
        rounded(d, (x, 756, x + w, 818), 18, (31, 33, 39, 255), LINE)
        d.text((x + 18, 775), title, font=fr(11), fill=MUTED)
        d.text((x + 18, 796), value, font=fb(15), fill=WHITE)
        x += w + 12
    rounded(d, (490, 830, 1034, 862), 16, (28, 30, 35, 255))
    d.text((508, 839), '例如：继续处理待审批的终端步骤，并把最新产物直接挂到右侧。', font=fr(12), fill=DIM)


def draw_right_home(d):
    rounded(d, (1098, 206, 1388, 354), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 226), '待审批动作', font=fb(15), fill=WHITE)
    pill(d, (1282, 222, 1362, 246), '2 项等待', (76, 58, 32, 255), (255, 214, 156, 255))
    rounded(d, (1120, 254, 1366, 300), 14, (40, 36, 31, 255), (93, 75, 49, 255))
    d.text((1138, 271), '终端打包验证', font=fb(13), fill=WHITE)
    d.text((1138, 289), '等待批准后导出 Windows 构建截图', font=fr(10), fill=MUTED)
    d.text((1318, 272), '批准 →', font=fr(11), fill=(255, 214, 156, 255))
    rounded(d, (1120, 308, 1366, 336), 12, (35, 37, 43, 255))
    d.text((1138, 317), '页面发布到演示位', font=fr(11), fill=SOFT)
    d.text((1298, 317), '查看', font=fr(11), fill=(189, 213, 255, 255))

    rounded(d, (1098, 372, 1388, 560), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 392), '最新产物', font=fb(15), fill=WHITE)
    artifacts = [('首页产品稿 PNG', '刚刚生成 · 可直接预览'), ('Codex 骨架稿', '上一轮版本 · 供对照'), ('HTML 单页原型', '浏览器打开 · 继续拖改')]
    y = 424
    for title, sub in artifacts:
        rounded(d, (1120, y, 1366, y + 42), 13, (35, 37, 43, 255))
        d.text((1138, y + 10), title, font=fb(12), fill=WHITE)
        d.text((1138, y + 26), sub, font=fr(10), fill=MUTED)
        d.text((1306, y + 16), '打开 ↗', font=fr(10), fill=(189, 213, 255, 255))
        y += 50

    rounded(d, (1098, 578, 1388, 714), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 598), '来源状态', font=fb(15), fill=WHITE)
    sources = [('GitHub 仓库', '已连接', GREEN), ('Browser / 页面验证', '在线', BLUE), ('本地文件系统', '可读写', SOFT), ('MCP 服务', '2 个可用', (212, 197, 255, 255))]
    y = 628
    for title, status, col in sources:
        d.ellipse((1122, y + 6, 1132, y + 16), fill=col)
        d.text((1142, y), title, font=fr(11), fill=SOFT)
        d.text((1316, y), status, font=fr(11), fill=col)
        y += 22

    rounded(d, (1098, 732, 1388, 854), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 752), '当前焦点', font=fb(15), fill=WHITE)
    focus = [('会话', '桌面首页产品化'), ('最新动作', '已补齐右侧真实状态区'), ('下一步', '继续做运行中与待审批页')]
    y = 782
    for k, v in focus:
        d.text((1120, y), k, font=fr(11), fill=MUTED)
        d.text((1202, y), v, font=fr(11), fill=SOFT)
        y += 22


def draw_right_running(d):
    rounded(d, (1098, 206, 1388, 340), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 226), '运行快照', font=fb(15), fill=WHITE)
    rows = [('模型', 'DeepSeek Chat'), ('模式', '自动'), ('事件', '24'), ('活动工具', 'terminal / vision')]
    y = 258
    for k, v in rows:
        d.text((1120, y), k, font=fr(11), fill=MUTED)
        d.text((1260, y), v, font=fr(11), fill=SOFT)
        y += 22

    rounded(d, (1098, 358, 1388, 548), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 378), '当前工具执行', font=fb(15), fill=WHITE)
    tools = [('write_file', '完成', GREEN), ('terminal', '运行中', BLUE), ('vision_analyze', '排队', YELLOW)]
    y = 416
    for name, status, col in tools:
        rounded(d, (1120, y, 1366, y + 36), 12, (35, 37, 43, 255))
        d.text((1138, y + 11), name, font=fr(12), fill=WHITE)
        d.text((1298, y + 11), status, font=fr(11), fill=col)
        y += 46

    rounded(d, (1098, 566, 1388, 716), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 586), '最近产物', font=fb(15), fill=WHITE)
    d.text((1120, 622), '• refined 首页 PNG 已生成', font=fr(12), fill=SOFT)
    d.text((1120, 648), '• 套图脚本已写入', font=fr(12), fill=SOFT)
    d.text((1120, 674), '• 待审批页正在渲染', font=fr(12), fill=SOFT)

    rounded(d, (1098, 734, 1388, 854), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 754), '操作入口', font=fb(15), fill=WHITE)
    buttons = [('查看完整时间线', BLUE), ('打开最新 PNG', GREEN), ('跳到审批页', ORANGE)]
    y = 786
    for label, col in buttons:
        rounded(d, (1120, y, 1366, y + 26), 13, (35, 37, 43, 255), LINE)
        d.text((1138, y + 7), label, font=fr(11), fill=col)
        y += 32


def draw_right_approval(d):
    rounded(d, (1098, 206, 1388, 360), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 226), '影响范围', font=fb(15), fill=WHITE)
    impacts = [('文件写入', '3 个目标'), ('本地构建', '将启动'), ('外部链接', '可能新增 1 个')]
    y = 262
    for k, v in impacts:
        d.text((1120, y), k, font=fr(11), fill=MUTED)
        d.text((1290, y), v, font=fr(11), fill=SOFT)
        y += 26

    rounded(d, (1098, 378, 1388, 560), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 398), '批准后产物', font=fb(15), fill=WHITE)
    outputs = ['Windows 构建截图', '公开演示链接', '新的运行时间线事件']
    y = 434
    for item in outputs:
        rounded(d, (1120, y, 1366, y + 34), 12, (35, 37, 43, 255))
        d.text((1138, y + 10), item, font=fr(11), fill=SOFT)
        y += 42

    rounded(d, (1098, 578, 1388, 716), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 598), '来源与凭据', font=fb(15), fill=WHITE)
    d.text((1120, 632), 'GitHub 仓库：已授权', font=fr(12), fill=SOFT)
    d.text((1120, 658), 'Browser 验证：可用', font=fr(12), fill=SOFT)
    d.text((1120, 684), '发布目标：待确认', font=fr(12), fill=SOFT)

    rounded(d, (1098, 734, 1388, 854), 20, (30, 31, 37, 255), LINE)
    d.text((1120, 754), '快捷操作', font=fb(15), fill=WHITE)
    ops = [('先预览详情', SOFT), ('批准并继续', GREEN), ('拒绝并返回', RED)]
    y = 786
    for label, col in ops:
        rounded(d, (1120, y, 1366, y + 26), 13, (35, 37, 43, 255), LINE)
        d.text((1138, y + 7), label, font=fr(11), fill=col)
        y += 32


def export(name, painter):
    img, d = make_canvas()
    painter(img, d)
    out = OUTDIR / name
    out.parent.mkdir(parents=True, exist_ok=True)
    img.convert('RGB').save(out, quality=96)
    print(out)


if __name__ == '__main__':
    export('shiguang-agent-product-home-refined-v2.png', draw_home)
    export('shiguang-agent-running-page.png', draw_running)
    export('shiguang-agent-approval-page.png', draw_approval)
