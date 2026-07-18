const routes = {
  home: {
    title: "shiguang://workspace/home?view=home",
    subtitle: "桌面工作台",
    status: "DeepSeek 默认 · 7 个来源在线",
  },
  running: {
    title: "shiguang://workspace/runs/live?view=running",
    subtitle: "运行时间线",
    status: "实时流开启 · 5 个运行任务",
  },
  approval: {
    title: "shiguang://workspace/approvals?view=approval",
    subtitle: "待审批中心",
    status: "高风险动作待确认 · 2 项等待",
  },
};

const routeButtons = document.querySelectorAll("[data-route]");
const navItems = document.querySelectorAll(".nav-item[data-route]");
const pages = document.querySelectorAll("main .page");
const rightPages = document.querySelectorAll("aside.right .page");
const addr = document.getElementById("addr");
const subtitle = document.getElementById("subtitle");
const workspaceStatus = document.getElementById("workspace-status");

function activateRoute(route) {
  if (!routes[route]) return;
  pages.forEach((page) => page.classList.toggle("active", page.id === `page-${route}`));
  rightPages.forEach((page) => page.classList.toggle("active", page.id === `right-${route}`));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.route === route));
  addr.textContent = routes[route].title;
  subtitle.textContent = routes[route].subtitle;
  workspaceStatus.textContent = routes[route].status;
  window.history.replaceState({}, "", `#${route}`);
}

routeButtons.forEach((button) => {
  button.addEventListener("click", () => activateRoute(button.dataset.route));
});

const initialRoute = window.location.hash.replace("#", "") || "home";
activateRoute(initialRoute in routes ? initialRoute : "home");
