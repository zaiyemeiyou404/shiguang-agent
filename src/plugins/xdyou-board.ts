export interface CampusStat {
  label: string;
  value: string;
  hero?: boolean;
}

export interface CampusItem {
  title: string;
  meta: string;
  tone?: "warn" | "ok";
  aside?: string;
  meter?: number | null;
}

export interface CampusClass {
  name: string;
  place: string;
  start: string;
  end: string;
  period: number;
  stop: number;
  tone: number;
}

export interface CampusDay {
  label: string;
  today: boolean;
  classes: CampusClass[];
}

export interface CampusCard {
  id: string;
  title: string;
  subtitle: string;
  kind: "schedule" | "stats" | "list" | "note";
  stats: CampusStat[];
  items: CampusItem[];
  days: CampusDay[];
  empty?: string;
}

const TITLES: Record<string, string> = {
  schedule: "课表",
  scores: "成绩",
  exams: "考试",
  attendance: "考勤",
  card: "校园卡",
  loans: "借阅",
  classrooms: "空教室",
  meters: "水电",
  water: "宿舍水机",
  aircon: "空调",
  airconlive: "空调",
  electricity: "电费",
  experiments: "实验",
  sport: "体测",
  sportclass: "体育课",
  network: "校园网",
  schoolnet: "校园网账号",
  forum: "睿思",
  library: "图书馆",
  status: "缓存",
  login: "登录",
};

const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const TONES = ["#e2b878", "#8fbf8a", "#8eb4d4", "#d4a08a", "#c4b0d4"];
export const XDYOU_CARD_URI = "ui://xdyou/card.html";
const HIDDEN_KEYS = new Set([
  "ok", "dataset", "cacheUpdatedAt", "truncated", "note", "boardUrl", "boardFile",
  "weekOffsetSource", "credentialsReadable", "credentialsPresent", "usingSyncedCache",
  "dataDir", "syncDir", "classes", "days", "courses", "recent", "upcoming", "summary",
  "cardUrl",
]);

export function campusCardFromOutput(id: string, dataset: string, output: Record<string, unknown>): CampusCard {
  const title = TITLES[dataset] ?? "校园";
  if (output.ok === false) {
    return { id, title, subtitle: text(output.error) || "这次没有查到", kind: "note", stats: [], items: [], days: [] };
  }
  if (dataset === "schedule") return scheduleCard(id, title, output);
  if (dataset === "scores") return scoresCard(id, title, output);
  if (dataset === "exams") return examsCard(id, title, output);
  if (dataset === "attendance") return attendanceCard(id, title, output);
  if (dataset === "card") return cardBoard(id, title, output);
  if (dataset === "loans") return loansCard(id, title, output);
  if (dataset === "classrooms") return classroomsCard(id, title, output);
  return genericCard(id, title, output);
}

export function renderCardText(card: CampusCard, cardUrl?: string): string {
  const lines = [card.title, card.subtitle].filter(Boolean);
  if (card.stats.length > 0) lines.push(card.stats.map((stat) => `${stat.label} ${stat.value}`).join("  "));
  if (card.kind === "schedule") {
    for (const day of card.days) {
      if (day.classes.length === 0) continue;
      lines.push("", day.today ? `${day.label}（今天）` : day.label);
      for (const item of day.classes) lines.push([item.start && item.end ? `${item.start}–${item.end}` : "", item.name, item.place].filter(Boolean).join("  "));
    }
  } else {
    for (const item of card.items) lines.push([item.tone === "warn" ? `! ${item.title}` : item.title, item.aside, item.meta].filter(Boolean).join("  "));
    if (card.items.length === 0 && card.empty) lines.push(card.empty);
  }
  const text = lines.join("\n");
  return cardUrl ? `${text}\n卡片 ${cardUrl}` : text;
}

export function renderCampusBoardHtml(card: CampusCard): string {
  const payload = JSON.stringify(card).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(card.title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: #e7e1d6; color: #1c1916; font: 14px/1.35 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { max-width: 392px; padding: 18px 18px 10px; border-radius: 22px; background: #fbf9f4; box-shadow: 0 16px 40px rgba(48, 38, 24, .12); }
  .kicker { margin: 0 0 2px; color: #1f4e79; font-size: 11px; font-weight: 700; letter-spacing: .14em; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  h1 { margin: 0; font-size: 28px; font-weight: 680; letter-spacing: -.045em; }
  .week { margin: 0 0 3px; color: #6f675e; font-size: 13px; text-align: right; }
  .now { margin: 16px 0 4px; padding: 14px 14px 12px; border-radius: 16px; background: #1f4e79; color: #f7f4ee; }
  .now .label { margin: 0 0 8px; color: rgba(247,244,238,.7); font-size: 12px; }
  .now-class + .now-class { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(247,244,238,.16); }
  .time { margin: 0; font-variant-numeric: tabular-nums; color: #f0d7a2; font-size: 13px; }
  .now h2 { margin: 2px 0 0; font-size: 20px; font-weight: 650; letter-spacing: -.03em; }
  .place { margin: 3px 0 0; color: rgba(247,244,238,.78); font-size: 13px; }
  .rest { margin-top: 4px; }
  .day { display: grid; grid-template-columns: 22px minmax(0,1fr); gap: 10px; padding: 10px 2px; border-top: 1px solid #ece6db; }
  .dow { color: #8a8175; font-size: 13px; font-weight: 700; }
  .lesson { display: grid; grid-template-columns: 48px minmax(0,1fr); gap: 8px; align-items: start; }
  .lesson + .lesson { margin-top: 7px; }
  .lesson time { font-variant-numeric: tabular-nums; color: #6f675e; font-size: 12px; line-height: 1.45; }
  .lesson strong { display: block; font-size: 14px; font-weight: 640; }
  .lesson span { color: #8a8175; font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; margin-top: 14px; }
  .stats div { padding: 10px 8px; border-radius: 12px; background: #f3eee4; }
  .stats strong { display: block; font-size: 20px; letter-spacing: -.03em; }
  .stats span { color: #8a8175; font-size: 11px; }
  .hero { margin-top: 14px; padding: 16px 16px 14px; border-radius: 16px; background: #1f4e79; color: #f7f4ee; }
  .hero strong { display: block; font-size: 36px; font-weight: 680; letter-spacing: -.04em; }
  .hero span { color: rgba(247,244,238,.72); font-size: 12px; }
  .rows { list-style: none; margin: 12px 0 0; padding: 0; }
  .rows li { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid #ece6db; }
  .rows strong { display: block; font-size: 14px; font-weight: 640; }
  .rows span, .rows .meta { color: #8a8175; font-size: 12px; }
  .bar { display: block; height: 6px; margin-top: 6px; overflow: hidden; border-radius: 99px; background: #ece6db; }
  .bar i { display: block; height: 100%; border-radius: 99px; background: #1f4e79; }
  .rows li.warn .bar i, .rows li.warn strong, .aside.minus { color: #9a3412; }
  .rows li.warn .bar i { background: #9a3412; }
  .aside { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .empty { margin: 14px 0 8px; color: #8a8175; font-size: 13px; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; }
  li { padding: 10px 0; border-top: 1px solid #ece6db; }
  li strong { display: block; font-size: 14px; font-weight: 640; }
  li span { color: #8a8175; font-size: 12px; }
  li.warn strong { color: #9a3412; }
  .note { margin: 14px 0 8px; color: #3f3a34; }
  .card.grid { max-width: 780px; }
  .sheet-head, .sheet-body { display: grid; grid-template-columns: 44px repeat(7, minmax(0,1fr)); }
  .day-head { padding: 0 2px 8px; color: #6f675e; font-size: 13px; font-weight: 700; text-align: center; }
  .day-head.today { color: #1f4e79; }
  .times, .col { position: relative; height: var(--sheet-h); }
  .col { border-left: 1px solid #ece6db; }
  .col.today { background: rgba(31,78,121,.07); border-radius: 8px; }
  .tick { position: absolute; left: 0; right: 2px; }
  .tick b { display: block; font-size: 12px; line-height: 1.1; }
  .tick span { color: #8a8175; font-size: 10px; }
  .course { position: absolute; left: 3px; right: 3px; padding: 3px 4px; overflow: hidden; border-radius: 6px; }
  .course strong { display: block; font-size: 11px; font-weight: 700; line-height: 1.25; }
  .course span { display: block; margin-top: 2px; color: #4e4943; font-size: 10px; line-height: 1.2; }
</style>
</head>
<body><article class="card${card.kind === "schedule" ? " grid" : ""}" id="card">${cardBody(card)}</article>
<script type="application/json" id="xdyou-card">${payload}</script>
<script>
(function () {
  var host = window.parent;
  function text(value) { return value == null ? "" : String(value); }
  function el(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value) node.textContent = value;
    return node;
  }
  function render(card) {
    var root = document.getElementById("card");
    if (!root || !card) return;
    var head = el("header");
    head.append(el("p", "kicker", "西电"));
    var top = el("div", "top");
    top.append(el("h1", "", text(card.title) || "校园"));
    if (card.subtitle && card.kind !== "note") top.append(el("p", "week", text(card.subtitle)));
    head.append(top);
    root.className = "card" + (card.kind === "schedule" ? " grid" : "");
    root.replaceChildren(head);
    if (card.kind === "note") { root.append(el("p", "note", text(card.subtitle))); size(); return; }
    var stats = Array.isArray(card.stats) ? card.stats : [];
    stats.filter(function (stat) { return stat.hero; }).forEach(function (stat) {
      var hero = el("div", "hero");
      hero.append(el("strong", "", text(stat.value)), el("span", "", text(stat.label)));
      root.append(hero);
    });
    var figures = stats.filter(function (stat) { return !stat.hero; });
    if (figures.length) {
      var grid = el("div", "stats");
      figures.forEach(function (stat) { var box = el("div"); box.append(el("strong", "", text(stat.value)), el("span", "", text(stat.label))); grid.append(box); });
      root.append(grid);
    }
    if (card.kind === "schedule" && Array.isArray(card.days)) {
      var fills = ["#dbe7f6", "#d9ead3", "#fde7c7", "#f8d7da", "#e6dff5", "#d4efed", "#fbe4d0"];
      var clocks = ["08:30", "09:20", "10:25", "11:15", "14:00", "14:50", "15:55", "16:45", "19:00", "19:50", "20:40"];
      function rowTop(period) {
        var top = (period - 1) * 36;
        if (period > 4) top += 16;
        if (period > 8) top += 16;
        return top;
      }
      var sheetHeight = rowTop(12);
      var sheet = el("div", "sheet");
      var headRow = el("div", "sheet-head");
      headRow.append(el("div"));
      card.days.forEach(function (day) { headRow.append(el("div", day.today ? "day-head today" : "day-head", text(day.label).replace("周", ""))); });
      var body = el("div", "sheet-body");
      var times = el("div", "times");
      times.style.height = sheetHeight + "px";
      clocks.forEach(function (clock, index) {
        var tick = el("div", "tick");
        tick.style.top = rowTop(index + 1) + "px";
        tick.append(el("b", "", String(index + 1)), el("span", "", clock));
        times.append(tick);
      });
      body.append(times);
      card.days.forEach(function (day) {
        var col = el("div", day.today ? "col today" : "col");
        col.style.height = sheetHeight + "px";
        (day.classes || []).forEach(function (item) {
          var start = Number(item.period) || 1;
          var stop = Number(item.stop) || start;
          if (stop < start) stop = start;
          var block = el("div", "course");
          block.style.top = rowTop(start) + "px";
          block.style.height = Math.max(28, rowTop(stop + 1) - rowTop(start) - 4) + "px";
          block.style.background = fills[(Number(item.tone) || 0) % fills.length];
          block.append(el("strong", "", text(item.name)));
          if (item.place) block.append(el("span", "", text(item.place)));
          col.append(block);
        });
        body.append(col);
      });
      sheet.append(headRow, body);
      root.append(sheet);
    } else if (Array.isArray(card.items) && card.items.length) {
      var list = el("ul", "rows");
      card.items.forEach(function (item) {
        var row = el("li", item.tone === "warn" ? "warn" : "");
        var main = el("div");
        main.append(el("strong", "", text(item.title)));
        if (item.meta) main.append(el("span", "meta", text(item.meta)));
        if (typeof item.meter === "number") {
          var track = el("i", "bar");
          var fill = el("i");
          var width = Math.max(0, Math.min(100, item.meter));
          if (item.tone === "warn" && width < 8) width = 8;
          fill.style.width = width + "%";
          track.append(fill);
          main.append(track);
        }
        row.append(main);
        var asideClass = "aside";
        if (item.tone === "warn" || text(item.aside).charAt(0) === "-") asideClass += " minus";
        if (item.aside) row.append(el("b", asideClass, text(item.aside)));
        list.append(row);
      });
      root.append(list);
    } else if (card.empty) {
      root.append(el("p", "empty", text(card.empty)));
    }
    size();
  }
  function size() {
    host.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.body.scrollHeight } }, "*");
  }
  var embedded = document.getElementById("xdyou-card");
  if (embedded) render(JSON.parse(embedded.textContent || "{}"));
  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.method === "ui/initialize" && msg.id != null) {
      var version = msg.params && msg.params.protocolVersion || "2026-01-26";
      host.postMessage({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: version, appInfo: { name: "xdyou-card", version: "1.6.0" }, appCapabilities: {} } }, "*");
      host.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
      return;
    }
    if (msg.method === "ui/notifications/tool-result") {
      var params = msg.params || {};
      var structured = params.structuredContent || params;
      if (structured && structured.card) render(structured.card);
    }
  });
})();
</script>
</body>
</html>`;
}

const PERIOD_CLOCKS = ["08:30", "09:20", "10:25", "11:15", "14:00", "14:50", "15:55", "16:45", "19:00", "19:50", "20:40"];
const COURSE_FILLS = ["#dbe7f6", "#d9ead3", "#fde7c7", "#f8d7da", "#e6dff5", "#d4efed", "#fbe4d0"];

function rowTop(period: number): number {
  let top = (period - 1) * 36;
  if (period > 4) top += 16;
  if (period > 8) top += 16;
  return top;
}

function cardBody(card: CampusCard): string {
  const week = card.kind === "note" ? "" : card.subtitle;
  const header = `<header><p class="kicker">西电</p><div class="top"><h1>${esc(card.title)}</h1>${week ? `<p class="week">${esc(week)}</p>` : ""}</div></header>`;
  const heroes = card.stats.filter((stat) => stat.hero).map((stat) => `<div class="hero"><strong>${esc(stat.value)}</strong><span>${esc(stat.label)}</span></div>`).join("");
  const figures = card.stats.filter((stat) => !stat.hero);
  const stats = figures.length > 0
    ? `<div class="stats">${figures.map((stat) => `<div><strong>${esc(stat.value)}</strong><span>${esc(stat.label)}</span></div>`).join("")}</div>`
    : "";
  const grid = card.kind === "schedule" ? timetableHtml(card) : "";
  const items = card.kind === "schedule" || card.items.length === 0
    ? ""
    : `<ul class="rows">${card.items.map((item) => `<li class="${item.tone === "warn" ? "warn" : ""}"><div><strong>${esc(item.title)}</strong>${item.meta ? `<span class="meta">${esc(item.meta)}</span>` : ""}${typeof item.meter === "number" ? `<i class="bar"><i style="width:${meterWidth(item.meter, item.tone === "warn")}%"></i></i>` : ""}</div>${item.aside ? `<b class="aside${item.tone === "warn" || item.aside.startsWith("-") ? " minus" : ""}">${esc(item.aside)}</b>` : ""}</li>`).join("")}</ul>`;
  const blank = card.items.length === 0 && card.empty ? `<p class="empty">${esc(card.empty)}</p>` : "";
  const note = card.kind === "note" ? `<p class="note">${esc(card.subtitle)}</p>` : "";
  return `${header}${heroes}${grid}${stats}${items}${blank}${note}`;
}

function timetableHtml(card: CampusCard): string {
  const height = rowTop(12);
  const heads = card.days.map((day) => `<div class="day-head${day.today ? " today" : ""}">${esc(day.label.replace("周", ""))}</div>`).join("");
  const ticks = PERIOD_CLOCKS.map((clock, index) => `<div class="tick" style="top:${rowTop(index + 1)}px"><b>${index + 1}</b><span>${clock}</span></div>`).join("");
  const columns = card.days.map((day) => {
    const blocks = day.classes.map((item) => {
      const start = item.period;
      const stop = item.stop < start ? start : item.stop;
      const top = rowTop(start);
      const blockHeight = Math.max(28, rowTop(stop + 1) - top - 4);
      const fill = COURSE_FILLS[item.tone % COURSE_FILLS.length] ?? COURSE_FILLS[0];
      return `<div class="course" style="top:${top}px;height:${blockHeight}px;background:${fill}"><strong>${esc(item.name)}</strong>${item.place ? `<span>${esc(item.place)}</span>` : ""}</div>`;
    }).join("");
    return `<div class="col${day.today ? " today" : ""}" style="height:${height}px">${blocks}</div>`;
  }).join("");
  return `<div class="sheet"><div class="sheet-head"><div></div>${heads}</div><div class="sheet-body"><div class="times" style="height:${height}px">${ticks}</div>${columns}</div></div>`;
}

function scheduleCard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const weekday = text(output.weekday);
  const days = normalizeDays(output, weekday);
  const week = finite(output.week);
  const subtitle = [week === null ? "" : `第 ${week + 1} 周`, weekday, text(output.date)].filter(Boolean).join(" · ");
  return { id, title, subtitle, kind: "schedule", stats: [], items: [], days };
}

function normalizeDays(output: Record<string, unknown>, weekday: string): CampusDay[] {
  const provided = asRecords(output.days);
  if (provided.length > 0) {
    return provided.slice(0, 7).map((day) => ({
      label: text(day.label) || "周",
      today: text(day.label) === weekday,
      classes: asRecords(day.classes).slice(0, 12).map(asClass),
    }));
  }
  const classes = asRecords(output.classes).slice(0, 12).map(asClass);
  return WEEK_LABELS.map((label) => ({ label, today: label === weekday, classes: label === weekday ? classes : [] }));
}

function asClass(item: Record<string, unknown>): CampusClass {
  const name = text(item.name) || "未命名课程";
  const period = finite(item.start) ?? periodFromClock(text(item.startClock));
  const stop = finite(item.stop) ?? period + 1;
  return {
    name,
    place: text(item.classroom) || text(item.place),
    start: text(item.startClock) || clockText(item.start),
    end: text(item.endClock) || clockText(item.end),
    period,
    stop: stop < period ? period : stop,
    tone: toneFor(name),
  };
}

function scoresCard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const summary = asRecord(output.summary) ?? {};
  const items = asRecords(output.courses).filter((item) => item.passed !== true).slice(0, 6).map((item) => ({
    title: text(item.name) || "未命名课程",
    meta: [text(item.credit) ? `${text(item.credit)} 学分` : "", text(item.semesterCode)].filter(Boolean).join(" · "),
    aside: text(item.score) || text(item.level) || "未出",
    tone: item.passed === false ? "warn" as const : undefined,
  }));
  return {
    id,
    title,
    subtitle: text(output.semester) || "成绩概览",
    kind: "stats",
    stats: [
      { label: "已过学分", value: text(summary.passedCredits) || "0" },
      { label: "加权均分", value: text(summary.numericWeightedAverage) || "—" },
      { label: "未出", value: text(summary.pending) || "0" },
    ],
    items,
    days: [],
  };
}

function examsCard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const upcoming = asRecords(output.upcoming);
  return {
    id,
    title,
    subtitle: text(output.date) || "考试安排",
    kind: "list",
    stats: [{ label: "即将考试", value: String(upcoming.length) }, { label: "已结束", value: text(output.earlierCount) || "0" }],
    items: upcoming.slice(0, 8).map((item) => ({
      title: text(item.subject) || text(item.name) || "未命名考试",
      meta: [text(item.place), text(item.seat) ? `座位 ${text(item.seat)}` : ""].filter(Boolean).join(" · "),
      aside: text(item.start) || text(item.time),
    })),
    empty: upcoming.length === 0 ? "近期没有考试" : undefined,
    days: [],
  };
}

function attendanceCard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const courses = asRecords(output.courses);
  return {
    id,
    title,
    subtitle: text(output.semester) ? `学期 ${text(output.semester)}` : "本学期考勤",
    kind: "list",
    stats: [{ label: "课程", value: text(output.count) || String(courses.length) }, { label: "预警", value: text(output.warningCount) || "0" }],
    items: courses.slice(0, 18).map((item) => {
      const rate = text(item.rate);
      return {
        title: text(item.course) || "未命名课程",
        meta: text(item.absence) && text(item.absence) !== "---" && text(item.absence) !== "0" ? `旷课 ${text(item.absence)}` : "",
        aside: rate && rate !== "---" ? rate.replace(/\s*%/, "%") : "—",
        meter: percent(rate),
        tone: item.warning === true ? "warn" as const : undefined,
      };
    }),
    days: [],
  };
}

function cardBoard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const recent = asRecords(output.recent);
  return {
    id,
    title,
    subtitle: "最近 30 天",
    kind: "stats",
    stats: [{ label: "余额", value: text(output.balance) || "—", hero: true }, { label: "近 30 天", value: text(output.recentCount) || String(recent.length) }],
    items: recent.slice(0, 8).map((item) => ({
      title: text(item.place) || text(item.merchant) || "消费",
      meta: shortWhen(text(item.date) || text(item.time)),
      aside: text(item.amount),
    })),
    days: [],
  };
}

function genericCard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const stats = Object.entries(output).flatMap(([key, value]) => {
    if (HIDDEN_KEYS.has(key)) return [];
    if (typeof value === "number" || (typeof value === "string" && value.length > 0 && value.length <= 24)) {
      return [{ label: key, value: String(value) }];
    }
    return [];
  }).slice(0, 3);
  const lists = Object.entries(output).find(([key, value]) => !HIDDEN_KEYS.has(key) && Array.isArray(value));
  const items = Array.isArray(lists?.[1]) ? lists[1].slice(0, 8).flatMap((item) => {
    const row = asRecord(item);
    if (!row) return typeof item === "string" ? [{ title: item, meta: "" }] : [];
    const headingText = text(row.name) || text(row.title) || text(row.course) || text(row.place) || text(row.building);
    if (!headingText) return [];
    return [{ title: headingText, meta: text(row.place) || text(row.rate) || text(row.time) || text(row.classroom) || "" }];
  }) : [];
  return { id, title, subtitle: text(output.note) || "", kind: items.length > 0 ? "list" : stats.length > 0 ? "stats" : "note", stats, items, days: [] };
}

function classroomsCard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const rooms = asRecords(output.rooms);
  return {
    id,
    title,
    subtitle: [text(output.date), text(output.building)].filter(Boolean).join(" · ") || "空闲教室",
    kind: "list",
    stats: [{ label: "空闲教室", value: text(output.count) || String(rooms.length) }],
    items: rooms.slice(0, 12).map((room) => ({
      title: text(room.name) || "教室",
      meta: text(room.building),
      aside: freePeriods(asRecords(room.free)),
    })),
    days: [],
    empty: rooms.length === 0 ? "这个时间没有空教室" : undefined,
  };
}

function freePeriods(slots: Record<string, unknown>[]): string {
  const groups: string[] = [];
  let start = "";
  let end = "";
  let previous = 0;
  for (const slot of slots) {
    const period = finite(slot.period);
    const slotStart = text(slot.start);
    const slotEnd = text(slot.end);
    if (period === null || !slotStart || !slotEnd) continue;
    if (!start || period !== previous + 1) {
      if (start && end) groups.push(start === end ? start : `${start}–${end}`);
      start = slotStart;
    }
    end = slotEnd;
    previous = period;
  }
  if (start && end) groups.push(start === end ? start : `${start}–${end}`);
  return groups.slice(0, 3).join("、");
}

function loansCard(id: string, title: string, output: Record<string, unknown>): CampusCard {
  const loans = asRecords(output.loans);
  return {
    id,
    title,
    subtitle: "图书借阅",
    kind: "list",
    stats: [{ label: "在借", value: text(output.count) || String(loans.length) }],
    items: loans.slice(0, 8).map((item) => ({
      title: text(item.title) || text(item.name) || text(item.book) || "图书",
      meta: text(item.due) || text(item.returnDate) || text(item.date),
      aside: text(item.status),
    })),
    days: [],
    empty: loans.length === 0 ? "现在没有在借的书" : undefined,
  };
}

function meterWidth(meter: number, warn: boolean): number {
  const width = Math.max(0, Math.min(100, meter));
  return warn && width < 8 ? 8 : width;
}

function shortWhen(value: string): string {
  const match = /(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]}-${match[2]} ${match[3]}` : value;
}

function percent(value: string): number | null {
  const match = /(-?\d+(?:\.\d+)?)\s*%/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function clockText(value: unknown): string {
  const raw = text(value);
  return raw.includes(":") ? raw : "";
}

function periodFromClock(clock: string): number {
  const minutes = clockMinutes(clock);
  if (minutes === null) return 1;
  if (minutes < 10 * 60 + 15) return 1;
  if (minutes < 12 * 60) return 3;
  if (minutes < 15 * 60 + 45) return 5;
  if (minutes < 18 * 60 + 30) return 7;
  return 9;
}

function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function toneFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % TONES.length;
  return hash;
}

function finite(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => { const row = asRecord(item); return row ? [row] : []; }) : [];
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}
