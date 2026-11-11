import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  projectAttendance,
  semesterFromCourseHtml,
} from "./xdyou-attendance.js";
import {
  groupCodeFromJwt,
  jwtFromLocation,
  projectCardBalance,
  projectCardTrades,
  projectForum,
  projectLoans,
  projectSchoolnet,
  projectSportClass,
  sportSign,
} from "./xdyou-personal.js";

test("personal projectors keep payment, loan, and forum fields narrow", () => {
  const balance = projectCardBalance("<ul><li><span>名称</span><span><span>x</span><span>18.50</span></span></li></ul>");
  assert.equal(balance, "18.50");
  assert.deepEqual(projectCardTrades({
    resultData: [{ mername: "食堂", txdate: "2026-11-11 12:00:00", txamt: "6.50", openid: "secret" }],
  }), [{ place: "食堂", date: "2026-11-11 12:00:00", amount: "6.50" }]);

  const loans = projectLoans({
    data: { searchResult: [{ title: "操作系统", author: "张三", loanDate: "2026-11-01", normReturnDate: "2026-12-01", locationName: "长安", renewTimes: 1, userName: "hidden" }] },
  });
  assert.deepEqual(loans, [{
    title: "操作系统",
    author: "张三",
    loanDate: "2026-11-01",
    dueDate: "2026-12-01",
    location: "长安",
    renewTimes: 1,
  }]);

  const schoolnet = projectSchoolnet(`
    <tr><td>校园网</td><td>1.2GB</td><td>20GB</td><td>2026-12-01</td></tr>
    <tr><td>联通</td><td>9GB</td><td>1GB</td><td>2026-11-01</td></tr>
    <tr><td>20200028</td><td>10.0.0.8</td><td>2小时</td><td>100MB</td><td>校园网</td><td></td><td></td></tr>
  `);
  assert.equal(schoolnet.used, "1.2GB");
  assert.equal(schoolnet.rest, "20GB");
  assert.deepEqual(schoolnet.devices, [{ ip: "10.0.0.8", online: "2小时", traffic: "100MB" }]);
  assert.equal(JSON.stringify(schoolnet).includes("20200028"), false);

  const forum = projectForum(`<a href="forum.php?mod=viewthread&amp;tid=1188318">二手教材</a>`);
  assert.equal(forum.ok, true);
  assert.deepEqual(forum.threads, [{ tid: "1188318", title: "二手教材" }]);
  assert.equal(projectForum("当前网络为校外访问").error, "睿思只能在校园网内访问。");
});

test("attendance and sport class projectors keep the useful fields", () => {
  const html = `<select id="yearList"><option value="2025-2026-1">old</option><option value="2026-2027-1" selected>current</option></select>
    <table><tr><th>课程名称</th></tr>
    <tr class="redtr"><td>大学物理</td><td>001</td><td>1</td><td>0</td><td>0</td><td>0</td><td>2</td><td>10</td><td>70%</td><td>1</td><td>0</td><td>3</td><td>1/4</td><td>0/0</td><td>0/1</td><td>0</td><td>1</td></tr>
    <tr><td>高等数学</td><td>002</td><td>8</td><td>0</td><td>0</td><td>0</td><td>0</td><td>8</td><td>100%</td><td>1</td><td>0</td><td>3</td><td>1/4</td><td>0/0</td><td>0/1</td><td>0</td><td>1</td></tr>
    </table>`;
  assert.equal(semesterFromCourseHtml(html), "2026-2027-1");
  const courses = projectAttendance(`课程名称${html}`);
  assert.equal(courses?.[0]?.course, "大学物理");
  assert.equal(courses?.[0]?.warning, true);
  assert.equal(courses?.[1]?.rate, "100%");
  assert.equal(courses?.[1]?.warning, false);
  assert.deepEqual(projectSportClass(
    { id: 1, score: "90" },
    {
      teacherCurriculumSysTermName: "2026-2027-1",
      teacherCurriculumTeachingCurriculumName: "篮球",
      teacherCurriculumSysUserName: "李老师",
      teacherCurriculumTeachingSchoolTimeName: "周三 5-6",
      teacherCurriculumTeachingAddressName: "体育馆",
    },
  ), {
    term: "2026-2027-1",
    name: "篮球",
    teacher: "李老师",
    time: "周三 5-6",
    place: "体育馆",
    score: "90",
  });
});

test("sport sign sorts keys and jwt helpers do not return the token payload", () => {
  assert.equal(sportSign({ b: "2", a: "1" }), createHash("md5").update("a=1&b=2").digest("hex"));
  assert.equal(jwtFromLocation("https://mfindxidian.libsp.cn/find/home?jwt=abc.def.ghi"), "abc.def.ghi");
  const payload = Buffer.from(JSON.stringify({ groupCode: "200755", name: "hidden" })).toString("base64url");
  assert.equal(groupCodeFromJwt(`aaa.${payload}.bbb`), "200755");
});
