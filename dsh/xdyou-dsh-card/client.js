window.__ModuleLoader__.load({
  id: "xdyou-dsh-card",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var createElement = React.createElement;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useState = React.useState;
    var tools = ["aircon", "airconlive", "attendance", "card", "classrooms", "electricity", "exams", "experiments", "forum", "library", "loans", "login", "meters", "network", "schedule", "schoolnet", "scores", "sport", "sportclass", "status", "water"];

    function textOf(block) {
      if (!block || !Array.isArray(block.content)) return "";
      return block.content.filter(function (part) {
        return part && part.type === "text" && typeof part.text === "string";
      }).map(function (part) { return part.text; }).join("\n");
    }

    function cardUrlOf(text) {
      var match = /卡片 (http:\/\/127\.0\.0\.1:47321\/c\/[a-f0-9]{12})/.exec(text);
      return match ? match[1] : "";
    }

    function XdyouCard(props) {
      var block = props.block;
      var settled = block && block.kind === "tool-result";
      var text = settled ? textOf(block) : "";
      var url = cardUrlOf(text);
      var frame = useRef(null);
      var heightState = useState(360);
      var height = heightState[0];
      var setHeight = heightState[1];
      useEffect(function () {
        if (!url) return undefined;
        function onMessage(event) {
          if (!frame.current || event.source !== frame.current.contentWindow) return;
          var data = event.data;
          if (!data || data.jsonrpc !== "2.0" || data.method !== "ui/notifications/size-changed") return;
          var next = data.params && Number(data.params.height);
          if (Number.isFinite(next) && next > 40 && next < 4000) setHeight(Math.ceil(next + 8));
        }
        window.addEventListener("message", onMessage);
        return function () { window.removeEventListener("message", onMessage); };
      }, [url]);
      if (!settled) return createElement("div", { style: { padding: "8px 0", color: "#8a8175" } }, "正在查询");
      if (block.isError || !url) return createElement("pre", { style: { margin: 0, whiteSpace: "pre-wrap" } }, text || "查询失败");
      return createElement("iframe", {
        ref: frame,
        src: url,
        title: "西电卡片",
        style: { width: "100%", maxWidth: "820px", height: height + "px", border: 0, borderRadius: "16px", background: "#e7e1d6" },
      });
    }

    function apply(ctx) {
      tools.forEach(function (id) {
        ctx.slots.inject("tool.call.toolview", function () {
          return ctx.slots.register({
            name: "tool.call.toolview",
            key: "mcp__xdyou__" + id,
          }, XdyouCard);
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
