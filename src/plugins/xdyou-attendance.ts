import type { SessionPage } from "./xdyou-personal.js";

export const ATTENDANCE_LOGIN_URL = "https://xdspoc.fanya.chaoxing.com/sso/xdspoc";
const COURSE_INFO_URL = "https://fycourse.fanya.chaoxing.com/courselist/study?v=1";
const COURSE_DATA_URL = "https://fycourse.fanya.chaoxing.com/courselist/studyCourseDatashow";

export function semesterFromCourseHtml(html: string): string {
  const yearList = html.match(/id=["']yearList["'][^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? "";
  const selected = yearList.match(/<option\b[^>]*selected[^>]*value=["']([^"']+)["']/i)
    ?? yearList.match(/<option\b[^>]*value=["']([^"']+)["'][^>]*selected/i);
  if (selected?.[1]) return selected[1].trim();
  return html.match(/semesternum=["']([^"']+)["']/i)?.[1]?.trim() ?? "";
}

export function projectAttendance(html: string): Array<Record<string, unknown>> | null {
  if (!html.includes("课程名称") && !html.includes("签到次数")) return null;
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? html;
  const courses: Array<Record<string, unknown>> = [];
  for (const match of table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const row = match[0];
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => (cell[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    if (cells.length < 9 || !cells[0]) continue;
    const rate = cells[8] ?? "";
    courses.push({
      course: cells[0],
      className: cells[1] ?? "",
      checkIn: cells[2] ?? "",
      personalLeave: cells[3] ?? "",
      sickLeave: cells[4] ?? "",
      officialLeave: cells[5] ?? "",
      absence: cells[6] ?? "",
      required: cells[7] ?? "",
      rate,
      warning: /class=["'][^"']*\bredtr\b/.test(row) || rateBelow(rate, 80),
    });
    if (courses.length >= 40) break;
  }
  return courses;
}

export async function fetchAttendance(page: SessionPage): Promise<Record<string, unknown>> {
  if (hostname(page.location()) === "ids.xidian.edu.cn") {
    return { ok: false, dataset: "attendance", needsLogin: true, error: "考勤还需要完成统一认证。" };
  }
  const course = await page.request(COURSE_INFO_URL, {
    method: "GET",
    headers: { referer: "https://fycourse.fanya.chaoxing.com/" },
  });
  if (course.status >= 400 || /type=["']password["']/i.test(course.text)) {
    return { ok: false, dataset: "attendance", needsLogin: true, error: "考勤还需要完成统一认证。" };
  }
  const semester = semesterFromCourseHtml(course.text);
  if (!semester) return { ok: false, dataset: "attendance", error: "考勤页面没有当前学期。" };
  const data = await page.request(`${COURSE_DATA_URL}?v=1&semesternum=${encodeURIComponent(semester)}`, {
    method: "GET",
    headers: {
      referer: "https://fycourse.fanya.chaoxing.com/courselist/study",
      "x-requested-with": "XMLHttpRequest",
    },
  });
  if (/type=["']password["']/i.test(data.text)) {
    return { ok: false, dataset: "attendance", needsLogin: true, error: "考勤还需要完成统一认证。" };
  }
  const courses = projectAttendance(data.text);
  if (!courses) return { ok: false, dataset: "attendance", error: "考勤接口没有返回课程表。" };
  return {
    ok: true,
    dataset: "attendance",
    semester,
    count: courses.length,
    warningCount: courses.filter((item) => item.warning === true).length,
    courses,
  };
}

function rateBelow(rate: string, limit: number): boolean {
  const value = Number(rate.replace("%", "").trim());
  return Number.isFinite(value) && value < limit;
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}
