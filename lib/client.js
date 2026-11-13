/**
 * dsh-cabinet — client bundle.
 * Registers the root-level "内阁模式" section in Settings left rail (matching Windows-MCP style)
 * and the bundle card in Settings -> Plugins.
 */
window.__ModuleLoader__.load({
  id: "dsh-cabinet",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var PACKAGE_ID = "dsh-cabinet";
    var VERSION = "0.1.0";
    var SETTINGS_SLOT = "settings.section";
    var SETTINGS_ICON_SLOT = "settings.section.icon";
    var SETTINGS_ENTRY_ID = "dsh-cabinet-settings";
    var SETTINGS_ORDER = 64;
    var REPO_URL = "https://github.com/sxczzl2008/dsh-cabinet";
    var STYLE_ID = "dsh-cabinet-settings-styles";

    var GITHUB_ICON_PATH =
      "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

    var CSS = [
      ".dcab-set{display:flex;flex-direction:column;gap:18px;max-width:980px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}",
      ".dcab-head{display:flex;flex-direction:column;gap:6px}",
      ".dcab-brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".dcab-title{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}",
      ".dcab-link{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#d7dee6);border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary,#65717d);text-decoration:none}",
      ".dcab-link:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f4f7);color:var(--dsw-alias-label-primary)}",
      ".dcab-version{font-size:12px;color:var(--dsw-alias-label-tertiary,#86909c)}",
      ".dcab-card{display:flex;flex-direction:column;gap:12px;padding:18px 20px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,#e3e8ee);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff))}",
      ".dcab-card__title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dcab-guide-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}",
      ".dcab-guide-item{padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f9fb);border:1px solid var(--dsw-alias-border-l1,#e8edf2)}",
      ".dcab-guide-item b{display:block;margin-bottom:4px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".dcab-guide-item span{font-size:12px;color:var(--dsw-alias-label-secondary,#65717d)}",
      ".dcab-rows{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 16px;margin:0;align-items:baseline}",
      ".dcab-rows dt{color:var(--dsw-alias-label-secondary,#65717d);white-space:nowrap}",
      ".dcab-rows dd{margin:0;min-width:0;overflow-wrap:anywhere}",
      ".dcab-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border-radius:8px;border:1px solid #3d609a;background:#3d609a;color:#fff}",
      ".dcab-btn:disabled{opacity:.55;cursor:not-allowed}",
      ".dcab-btn--quiet{background:transparent;color:var(--dsw-alias-label-secondary,#65717d);border-color:var(--dsw-alias-border-l1,#d7dee6)}",
      ".dcab-btn--quiet:hover{background:var(--dsw-alias-bg-layer-2,#f1f4f7);color:var(--dsw-alias-label-primary)}"
    ].join("");

    function installStyles() {
      if (typeof document === "undefined") return;
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = CSS;
    }

    function SettingsNavIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 16;
      return React.createElement(
        "svg",
        { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 16 16", width: size, height: size, fill: "currentColor", "aria-hidden": "true" },
        React.createElement("rect", { x: 1.5, y: 2, width: 5.5, height: 5.2, rx: 1.2 }),
        React.createElement("rect", { x: 9, y: 2, width: 5.5, height: 5.2, rx: 1.2 }),
        React.createElement("rect", { x: 1.5, y: 8.8, width: 5.5, height: 5.2, rx: 1.2 }),
        React.createElement("circle", { cx: 11.75, cy: 11.4, r: 2.6 })
      );
    }

    function CabinetSettingsPage() {
      var H = React.createElement;
      var bridge = globalThis.__dshCabinetV2;
      var ui = globalThis.__dshCabinetV2Ui;
      var Editor = ui && ui.ConfigEditor;

      var _draft = React.useState(null), draft = _draft[0], setDraft = _draft[1];
      var _rev = React.useState(1), revision = _rev[0], setRevision = _rev[1];
      var _runtimeInfo = React.useState(null), runtimeInfo = _runtimeInfo[0], setRuntimeInfo = _runtimeInfo[1];
      var _busy = React.useState(false), busy = _busy[0], setBusy = _busy[1];
      var _notice = React.useState(""), notice = _notice[0], setNotice = _notice[1];
      var _error = React.useState(""), error = _error[0], setError = _error[1];
      var _tick = React.useState(0), setTick = _tick[1];

      var load = React.useCallback(function () {
        if (!bridge || !bridge.getPlan) return;
        setBusy(true); setError(""); setNotice("");
        bridge.getPlan().then(function (res) {
          setDraft(JSON.parse(JSON.stringify(res.plan)));
          setRevision(res.revision || 1);
          if (res.runtimeInfo) setRuntimeInfo(res.runtimeInfo);
        }).catch(function (e) {
          setError(e.message || "读取全局默认方案未完成");
        }).finally(function () {
          setBusy(false);
        });
      }, [bridge]);

      React.useEffect(function () {
        var refresh = function () { setTick(function (n) { return n + 1; }); load(); };
        load();
        window.addEventListener("dsh-cabinet-v2-ready", refresh);
        window.addEventListener("dsh-cabinet-v2-ui-ready", refresh);
        return function () {
          window.removeEventListener("dsh-cabinet-v2-ready", refresh);
          window.removeEventListener("dsh-cabinet-v2-ui-ready", refresh);
        };
      }, [load]);

      var saveMasterPlan = function () {
        if (!draft || busy || !bridge || !bridge.savePlan) return;
        setBusy(true); setError(""); setNotice("");
        bridge.savePlan(draft, revision).then(function (res) {
          setDraft(JSON.parse(JSON.stringify(res.plan)));
          setRevision(res.revision);
          setNotice("✓ 已保存为全局默认方案（母本 v" + res.revision + "），新建内阁对话将自动采用此配置");
        }).catch(function (e) {
          setError(e.message || "保存未完成");
        }).finally(function () {
          setBusy(false);
        });
      };

      var resetBlankMaster = function () {
        var blank = {
          schemaVersion: 2,
          blankDefaultInitialized: true,
          kind: "plan",
          id: "default-cabinet-plan",
          slotCount: 3,
          secretary: { id: "secretary", label: "秘书席", model: null },
          seats: [],
          staging: [],
          policies: { handoff: "wait", humanApprovalRequired: false, memberPool: { scope: "group", seatIds: [] } }
        };
        setDraft(blank);
        setNotice("已重置为空白草稿，点击「保存全局默认方案」生效");
      };
      return renderSettingsContent({ H, VERSION, REPO_URL, GITHUB_ICON_PATH, revision, runtimeInfo, error, notice, draft, setDraft, setNotice, Editor, busy, saveMasterPlan, resetBlankMaster, load });
    }

    function renderSettingsContent(p) {
      var H = p.H;
      return H("div", { className: "dcab-set", "data-cabinet-root-settings": "" },
        H("div", { className: "dcab-head" },
          H("div", { className: "dcab-brand" },
            H("h2", { className: "dcab-title" }, "内阁模式"),
            H("a", { className: "dcab-link", href: p.REPO_URL, target: "_blank", rel: "noopener noreferrer" },
              H("svg", { style: { width: 13, height: 13, display: "block" }, viewBox: "0 0 24 24", "aria-hidden": "true" },
                H("path", { fill: "currentColor", d: p.GITHUB_ICON_PATH })
              ),
              "GitHub"
            ),
            H("span", { className: "dcab-version" }, "v" + p.VERSION)
          )
        ),

        H("section", { className: "dcab-card" },
          H("h3", { className: "dcab-card__title" }, "使用指引（快速上手）"),
          H("div", { className: "dcab-guide-grid" },
            H("div", { className: "dcab-guide-item" },
              H("b", null, "1. 如何进入内阁模式"),
              H("span", null, "在任意聊天对话输入框右下角的「模型选择下拉菜单」底部，点击「内阁模式」即可弹出本任务排席窗口；应用后对话右侧自动挂出窄版状态栏。")
            ),
            H("div", { className: "dcab-guide-item" },
              H("b", null, "2. 鼠标点选与气泡拖拽"),
              H("span", null, "从右上角下拉框点选模型生成气泡，拖入下方工作席（1～9 席，可同列增减）或右侧秘书席（可选），再把「设计席 / 施工席 / 审验席」与「组长 / 组员 / 独立」拖入模型卡片。")
            ),
            H("div", { className: "dcab-guide-item" },
              H("b", null, "3. 全局母本与对话子代关系"),
              H("span", null, "本页保存的是「全局默认母本」，新开内阁对话会自动带入；在单个对话内调整排席只作用于该对话（子代），也可在对话弹窗底部点「一键设为默认配置」反向更新母本。")
            ),
            H("div", { className: "dcab-guide-item" },
              H("b", null, "4. 状态栏三色进度与控制"),
              H("span", null, "红 = 出错需人工排障；黄 = 思考/讨论/执行工具中；绿 = 正式成果已转交。支持随时查看组内讨论、发送补充指令、单独停止某组或停止全部工作。")
            )
          )
        ),

        H("section", { className: "dcab-card" },
          H("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 } },
            H("h3", { className: "dcab-card__title" }, "全局默认方案（母本配置）"),
            H("span", { style: { fontSize: 12, color: "#65717d" } }, "新开启「内阁模式」的对话将默认载入此方案 · 当前母本版本 v" + p.revision)
          ),
          p.error && H("div", { role: "alert", style: { color: "#be6262", fontSize: 13 } }, p.error),
          p.notice && H("div", { role: "status", style: { color: "#2d8f54", fontSize: 13 } }, p.notice),
          p.draft && typeof p.Editor === "function"
            ? H(p.Editor, { value: p.draft, onChange: function (v) { p.setDraft(v); p.setNotice(""); }, disabled: p.busy, context: "plan" })
            : H("p", { style: { color: "#65717d", margin: 0 } }, "正在加载内阁画布组件…"),
          H("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
            H("button", { type: "button", className: "dcab-btn", disabled: p.busy || !p.draft, onClick: p.saveMasterPlan }, p.busy ? "保存中…" : "保存全局默认方案"),
            H("button", { type: "button", className: "dcab-btn dcab-btn--quiet", disabled: p.busy, onClick: p.resetBlankMaster }, "重置为空白默认"),
            H("button", { type: "button", className: "dcab-btn dcab-btn--quiet", disabled: p.busy, onClick: p.load }, "重新读取已保存母本")
          )
        ),

        H("section", { className: "dcab-card" },
          H("h3", { className: "dcab-card__title" }, "插件与运行状态"),
          H("dl", { className: "dcab-rows" },
            H("dt", null, "插件名称"), H("dd", null, "dsh-cabinet（内阁多模型协作工作流）"),
            H("dt", null, "当前版本"), H("dd", null, "v" + p.VERSION),
            H("dt", null, "插件目录"), H("dd", null, (p.runtimeInfo && p.runtimeInfo.pluginPath) || "由当前 DSH Profile 动态加载"),
            H("dt", null, "母本存储"), H("dd", null, (p.runtimeInfo && p.runtimeInfo.planFilePath) || "$DSH_HOME/cabinet-v2/saved-plan.json"),
            H("dt", null, "对话入口"), H("dd", null, "原对话输入框右下角模型选择菜单 → 内阁模式")
          )
        )
      );
    }

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject(SETTINGS_ICON_SLOT, function () {
          return ctx.slots.register({ name: SETTINGS_ICON_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: function () { return "内阁模式"; } }, SettingsNavIcon);
        });
        ctx.slots.inject(SETTINGS_SLOT, function () {
          return ctx.slots.register({ name: SETTINGS_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: function () { return "内阁模式"; } }, CabinetSettingsPage);
        });
        ctx.slots.inject("plugins.bundle.config", function () {
          return ctx.slots.register({ name: "plugins.bundle.config", key: PACKAGE_ID, label: function () { return "内阁模式"; } }, function () {
            return React.createElement("p", { style: { margin: 0, fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, "内阁模式已就绪。请在左侧「内阁模式」设置页配置全局默认方案，或在对话右下角模型下拉菜单中选择「内阁模式」启动。");
          });
        });
      } catch (e) {
        console.error("[dsh-cabinet] slot registration error:", e);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
