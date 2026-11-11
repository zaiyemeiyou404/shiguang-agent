import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campusCardFromOutput, renderCampusBoardHtml, type CampusCard } from "./xdyou-board.js";
import { syncedXdyouDataDir } from "./xdyou-paths.js";

export const XDYOU_BOARD_PORT = 47321;
export const XDYOU_BOARD_URL = `http://127.0.0.1:${XDYOU_BOARD_PORT}/`;

let server: Server | null = null;

export function boardPublishingEnabled(): boolean {
  if (process.env.XDYOU_BOARD === "0") return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  if (process.execArgv.includes("--test") || process.argv.includes("--test")) return false;
  return true;
}

export function xdyouBoardFile(): string {
  return join(syncedXdyouDataDir(), "board.html");
}

export function boardPath(url: string | undefined): { ok: true; id: string | null } | { ok: false } {
  let pathname = "/";
  try {
    pathname = decodeURIComponent(new URL(url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    return { ok: false };
  }
  if (pathname === "/") return { ok: true, id: null };
  const match = /^\/c\/([a-f0-9]{12})$/.exec(pathname);
  return match?.[1] ? { ok: true, id: match[1] } : { ok: false };
}

export function xdyouCardUrl(id: string): string {
  return `${XDYOU_BOARD_URL}c/${id}`;
}

export function publishXdyouBoard(dataset: string, output: Record<string, unknown>): Record<string, unknown> {
  if (!boardPublishingEnabled()) return output;
  const id = randomBytes(6).toString("hex");
  const card = campusCardFromOutput(id, dataset, output);
  const html = renderCampusBoardHtml(card);
  const root = syncedXdyouDataDir();
  mkdirSync(join(root, "cards"), { recursive: true });
  writeFileSync(join(root, "cards", `${id}.json`), JSON.stringify(card));
  writeFileSync(xdyouBoardFile(), html);
  ensureXdyouBoardServer();
  return { ...output, card, cardUrl: xdyouCardUrl(id), boardUrl: XDYOU_BOARD_URL, boardFile: xdyouBoardFile() };
}

export function readXdyouCardHtml(id: string): string | null {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  try {
    const card = JSON.parse(readFileSync(join(syncedXdyouDataDir(), "cards", `${id}.json`), "utf8")) as CampusCard;
    return renderCampusBoardHtml(card);
  } catch {
    return null;
  }
}

export function readXdyouBoardHtml(): string {
  try {
    return readFileSync(xdyouBoardFile(), "utf8");
  } catch {
    return renderCampusBoardHtml({
      id: "empty",
      title: "校园",
      subtitle: "还没有查询。查一次课表、成绩或考勤后，这里会更新。",
      kind: "note",
      stats: [],
      items: [],
      days: [],
    });
  }
}

export function ensureXdyouBoardServer(): void {
  if (server) return;
  const next = createServer((request, response) => {
    const route = boardPath(request.url);
    const html = !route.ok ? null : route.id ? readXdyouCardHtml(route.id) : readXdyouBoardHtml();
    if (html === null) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    response.end(html);
  });
  next.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") {
      server = null;
      process.stderr.write(`xdyou board server: ${error.message}\n`);
    }
  });
  next.listen(XDYOU_BOARD_PORT, "127.0.0.1");
  server = next;
}
