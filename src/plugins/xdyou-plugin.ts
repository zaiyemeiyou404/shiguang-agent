import type { PluginAdapter } from "./registry.js";
import type { PluginCallRequest, PluginCallResult, PluginManifest } from "./types.js";
import { publishXdyouBoard } from "./xdyou-board-server.js";
import { queryXdyou } from "./xdyou-cache.js";

const queryInputSchema = {
  type: "object",
  properties: {
    date: { type: "string", description: "YYYY-MM-DD in Asia/Shanghai. Defaults to today." },
    week: { type: "number", description: "Zero-based semester week." },
    weekOffset: { type: "number", description: "XDYou week swift. Defaults to 0." },
    semester: { type: "string" },
    query: { type: "string" },
    limit: { type: "number" },
    dataDir: { type: "string", description: "XDYou application support directory." },
  },
};

function sessionCapability(id: string, description: string) {
  return { ...capability(id, description), timeoutMs: 360_000 };
}

function capability(id: string, description: string) {
  return {
    id,
    description,
    sideEffect: "read" as const,
    requiresApproval: false,
    timeoutMs: 5_000,
    inputSchema: id === "status" ? { type: "object", properties: { dataDir: { type: "string" } } } : queryInputSchema,
    outputSchema: { type: "object" },
  };
}

export const xdyouManifest: PluginManifest = {
  pluginId: "xdyou",
  name: "XDYou",
  version: "1.6.0",
  description: "XDYou campus data for 西电. Reads the local cache and opens login windows for 课表, 成绩, 考试, 校园卡, 借阅, 考勤, 水电, 宿舍水机, 校园网账号, 体测, 体育课, and 睿思. Each result includes a generic card that MCP App hosts can draw. Air-conditioner status is read-only. Does not store passwords.",
  capabilities: [
    capability("status", "List which XDYou cache files exist: 课表 考试 成绩 电费 实验 空调."),
    capability("schedule", "Read the XDYou 课表 and return the drawn week card. Use for 今天有什么课, 上课, 课程表, 画课表, 画个图. Call it again when the user asks for a picture. Do not write a script or generate a PNG."),
    capability("exams", "Read cached XDYou 考试 arrangements."),
    capability("scores", "Read cached XDYou 成绩, 学分, and a numeric weighted average."),
    capability("electricity", "Read cached XDYou 电费, 用电, dorm electricity and recent history."),
    capability("experiments", "Read cached XDYou 物理实验 and other 实验."),
    capability("aircon", "Read cached XDYou 空调 electricity."),
    capability("library", "Search the Xidian library catalog. Use for 图书馆, 查书, 借书, ISBN, 书名."),
    capability("network", "Read the current Xidian campus-network session usage. Use for 校园网, 网费, 流量."),
    {
      ...capability("classrooms", "Query empty Xidian classrooms and their free periods. Use for 空教室, 空闲教室. Requires the XDYou login session. query or building is an optional building name such as B楼. Leave both empty to query empty classrooms. Do not pass 空教室 or 教学楼 as the building name."),
      timeoutMs: 180_000,
      inputSchema: {
        ...queryInputSchema,
        properties: {
          ...queryInputSchema.properties,
          query: { type: "string", description: "Optional teaching-building name, such as B楼. Leave empty to query empty classrooms. Do not pass 空教室 or 教学楼." },
          building: { type: "string", description: "Optional teaching-building name. Same role as query." },
        },
      },
    },
    sessionCapability("card", "Read the campus-card balance and recent transactions. Use for 校园卡, 一卡通, 饭卡. Opens the login window if the unified sign-in has expired. Does not return the payment QR code."),
    sessionCapability("loans", "Read current personal library loans. Use for 个人借阅, 还书, 我借了什么. Opens the login window if needed."),
    sessionCapability("schoolnet", "Read the campus-network account usage and online devices. Use for 校园网账号, 上网账号, 在线设备. Opens the school-net login window if needed."),
    sessionCapability("forum", "Read recent 睿思 forum threads after login. Campus network only. Opens the forum login window if needed."),
    sessionCapability("sport", "Read 体测 scores. Opens a window for the separate sport password, which is not stored."),
    sessionCapability("sportclass", "Read 体育课 classes. Uses the sport-system session. Opens a window for the separate sport password, which is not stored."),
    sessionCapability("attendance", "Read Chaoxing 考勤 for the current semester: check-in, absence, and attendance rate. Reuses the unified sign-in."),
    sessionCapability("meters", "Read live dorm 水电 balances from the campus energy page. Reuses the unified sign-in. Campus network may be required."),
    sessionCapability("water", "List 宿舍水机 devices after an SMS login. The phone number and SMS code are not stored. Does not start or stop water."),
    {
      ...capability("airconlive", "Read the live air-conditioner state and electricity for the device saved by XDYou. Use for 空调状态, 空调开着没. Does not send power commands."),
      timeoutMs: 15_000,
    },
    {
      id: "login",
      description: "Open the Xidian unified-login window. After the user signs in, sync 课表, 成绩, and 考试. Use for 登录, 同步课表, 同步成绩, 同步考试. Does not store the password.",
      sideEffect: "read",
      requiresApproval: false,
      timeoutMs: 360_000,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    },
  ],
};

export const xdyouPlugin: PluginAdapter = {
  manifest: xdyouManifest,
  async execute(request: PluginCallRequest): Promise<PluginCallResult> {
    const started = Date.now();
    if (request.pluginId !== xdyouManifest.pluginId) {
      return { ok: false, output: null, error: "plugin mismatch", durationMs: 0 };
    }
    if (!xdyouManifest.capabilities.some((item) => item.id === request.capability)) {
      return { ok: false, output: null, error: `unknown capability: ${request.capability}`, durationMs: 0 };
    }
    try {
      const input = request.input && typeof request.input === "object"
        ? { ...(request.input as Record<string, unknown>), dataset: request.capability }
        : { dataset: request.capability };
      const queried = await queryXdyou(input, request.signal ? { signal: request.signal } : undefined);
      const output = publishXdyouBoard(request.capability, queried);
      const error = output.ok === false && typeof output.error === "string" ? output.error : null;
      return { ok: error === null, output, error, durationMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  },
};
