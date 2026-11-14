'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { open, pack, hash } = require('./asar-lib.cjs');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(PLUGIN_ROOT, 'lib/ui');
const BACKUP_DIR = path.join(PLUGIN_ROOT, 'backups/formal-baseline');

function resolveDshEnvironment() {
  const homeCandidates = [
    process.env.DSH_HOME,
    path.join(os.homedir(), '.dsh')
  ].filter(Boolean);
  const formalHome = homeCandidates.find(p => fs.existsSync(path.join(p, 'profiles/desktop'))) || homeCandidates[0];

  const appCandidates = [
    process.env.DSH_APP_DIR,
    path.join(process.env.ProgramFiles || '', 'DeepSeek Harness'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness')
  ].filter(Boolean);
  const appDir = appCandidates.find(p => fs.existsSync(path.join(p, 'resources/app.asar'))) || appCandidates[0];

  return {
    formalHome: path.resolve(formalHome),
    formalProfile: path.resolve(formalHome, 'profiles/desktop'),
    formalAsar: path.resolve(appDir, 'resources/app.asar'),
    formalExe: path.resolve(appDir, 'DeepSeek Harness.exe')
  };
}

const DSH_ENV = resolveDshEnvironment();
const FORMAL_ASAR = DSH_ENV.formalAsar;
const FORMAL_HOME = DSH_ENV.formalHome;
const FORMAL_PROFILE = DSH_ENV.formalProfile;
const EXPECTED_BASE_SHA = '14CFD81C9135BF0AFB89417543C94F9ECFE09266574452A9B106890C698725AE';

const PATHS = {
  sessionController: 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js',
  modelSelection: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js',
  settingsPlugins: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js',
  layout: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js',
  sidebarRight: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js',
  chat: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
};

function once(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`Patch anchor [${label}]: expected 1, got ${count}`);
  return source.replace(from, to);
}

function patchSessionController(source) {
  source = source.replace(/\r\n/g, '\n');
  const importAnchor = 'import { SessionLogOffset, SessionSeq, isAppendSurfaceEvent } from "@deepseek-ai/dsh-session";';
  const modeHelper = `${importAnchor}
function cabinetV2Mode(session) {
  const last = session?.snapshotEvents?.().findLast(e => e.type === "plugin:cabinet-v2/transition");
  return last?.data?.mode === "cabinet" ? "cabinet" : "ordinary";
}`;
  source = once(source, importAnchor, modeHelper, 'controller-mode-helper');

  const selectAnchor = '\t\t\t\tagent.model.select(selected);';
  const selectPatch = `\t\t\t\tconst cabinetV2 = this.ctx.get("cabinetV2");
\t\t\t\tif (cabinetV2) await cabinetV2.selectOrdinary(agent, selected, () => agent.model.select(selected));
\t\t\t\telse agent.model.select(selected);`;
  source = once(source, selectAnchor, selectPatch, 'controller-select-ordinary');

  const promptAnchor = '\t\t\t\t\tif (request.mode === "steer") agent.steer(message);\n\t\t\t\t\telse agent.followup(message);';
  const promptPatch = `\t\t\t\t\tconst cabinetV2 = this.ctx.get("cabinetV2");
\t\t\t\t\tif (cabinetV2Mode(agent.session) === "cabinet" && cabinetV2) {
\t\t\t\t\t\tawait cabinetV2.admit(agent, message, request);
\t\t\t\t\t} else if (request.mode === "steer") agent.steer(message);
\t\t\t\t\telse agent.followup(message);`;
  source = once(source, promptAnchor, promptPatch, 'controller-admit-prompt');

  const blankAnchor = '\tconst blank = state.blank && event.type !== "turn/start";';
  const blankPatch = '\tconst blank = state.blank && event.type !== "turn/start" && !(event.type === "plugin:cabinet-v2/transition" && event.data?.mode === "cabinet");';
  source = once(source, blankAnchor, blankPatch, 'controller-session-list-blank');
  return source;
}

function patchModelSelection(source) {
  source = source.replace(/\r\n/g, '\n');
  const canvasCode = fs.readFileSync(path.join(UI_DIR, 'canvas-editor.js'), 'utf8');
  const clientSectionCode = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib/client.js'), 'utf8');
  source = once(source, '\t\tlet react_dom = require("react-dom");', '\t\tlet react_dom = require("react-dom");\n' + canvasCode, 'canvas-editor');

  const receiptAnchor = '\t\t\t\t});\n\t\t\t\tif (this.disposed || generation !== this.generation) return result.ok ? {';
  source = once(source, receiptAnchor, `\t\t\t\t});
        if (result.ok && globalThis.__dshCabinetV2?.refresh) {
          try { await globalThis.__dshCabinetV2.refresh(this.sessionId); } catch {}
        }
\t\t\t\tif (this.disposed || generation !== this.generation) return result.ok ? {`, 'ordinary-selection-refresh');

  const hooks = `
      const v2Bridge = globalThis.__dshCabinetV2;
      const [, v2Bump] = react.useState(0);
      const [v2ModalOpen, v2SetModalOpen] = react.useState(false);
      const [v2DraftTask, v2SetDraftTask] = react.useState(null);
      const [v2ExpectedVersion, v2SetExpectedVersion] = react.useState(0);
      const [v2PlanRev, v2SetPlanRev] = react.useState(1);
      const [v2Loading, v2SetLoading] = react.useState(false);
      const [v2Saving, v2SetSaving] = react.useState(false);
      const [v2NoticeText, v2SetNoticeText] = react.useState("");
      const [v2ErrorMessages, v2SetErrorMessages] = react.useState([]);
      react.useEffect(() => {
        const notify = () => v2Bump(v => v + 1);
        const off = v2Bridge?.subscribe?.(notify);
        v2Bridge?.refresh?.(sessionId).catch(() => {});
        globalThis.addEventListener("dsh-cabinet-v2-ready", notify);
        return () => { if (typeof off === "function") off(); globalThis.removeEventListener("dsh-cabinet-v2-ready", notify); };
      }, [sessionId, v2Bridge]);
      const v2Snapshot = v2Bridge?.snapshot?.(sessionId);
      const v2IsCabinet = v2Snapshot?.mode === "cabinet";
      react.useEffect(() => {
        const opener = () => v2OpenConfiguration();
        cabinetV2Ui.taskOpeners.set(sessionId, opener);
        return () => { if (cabinetV2Ui.taskOpeners.get(sessionId) === opener) cabinetV2Ui.taskOpeners.delete(sessionId); };
      }, [sessionId, v2Bridge]);
  `;
  source = once(source, 'function ModelSelect({ locked, available, directory, load, select, resolveText, t, renderSlot }) {', 'function ModelSelect({ sessionId, locked, available, directory, load, select, resolveText, t, renderSlot }) {' + hooks, 'hooks');

  const helpersTop = `
      const v2OpenConfiguration = async () => {
        v2SetModalOpen(true); v2SetLoading(true); v2SetErrorMessages([]); v2SetNoticeText(""); close(true);
        try {
          const [saved] = await Promise.all([v2Bridge.getPlan(), v2Bridge.refresh(sessionId)]);
          const fact = v2Bridge.snapshot(sessionId);
          const current = fact?.config ?? fact?.task;
          v2SetPlanRev(saved?.revision || 1);
          v2SetExpectedVersion(Number.isSafeInteger(fact?.configVersion) ? fact.configVersion : 0);
          v2SetDraftTask(current ? cabinetV2Clone(current) : cabinetV2Ui.taskFromPlan(saved.plan, sessionId));
        } catch (err) {
          v2SetErrorMessages(cabinetV2Errors(err));
        } finally {
          v2SetLoading(false);
        }
      };
      const v2CancelConfiguration = () => {
        if (v2Saving) return;
        v2SetModalOpen(false); v2SetDraftTask(null); v2SetErrorMessages([]); v2SetNoticeText("");
      };
      const v2PromoteToDefaultPlan = async () => {
        if (v2Saving || v2Loading || !v2DraftTask) return;
        v2SetSaving(true); v2SetErrorMessages([]); v2SetNoticeText("");
        try {
          const res = await v2Bridge.savePlan(v2DraftTask, v2PlanRev);
          v2SetPlanRev(res.revision || (v2PlanRev + 1));
          v2SetNoticeText("✓ 已将当前排席设为全局默认配置（母本 v" + (res.revision || (v2PlanRev + 1)) + "）");
        } catch (err) {
          v2SetErrorMessages(cabinetV2Errors(err));
        } finally {
          v2SetSaving(false);
        }
      };
      const v2ReloadFromDefaultPlan = async () => {
        if (v2Saving || v2Loading) return;
        v2SetLoading(true); v2SetErrorMessages([]); v2SetNoticeText("");
        try {
          const saved = await v2Bridge.getPlan();
          v2SetPlanRev(saved?.revision || 1);
          v2SetDraftTask(cabinetV2Ui.taskFromPlan(saved.plan, sessionId));
          v2SetNoticeText("已从全局默认配置载入排席");
        } catch (err) {
          v2SetErrorMessages(cabinetV2Errors(err));
        } finally {
          v2SetLoading(false);
        }
      };
      const v2ApplyConfiguration = async () => {
        if (v2Saving || v2Loading || !v2DraftTask) return;
        v2SetSaving(true); v2SetErrorMessages([]); v2SetNoticeText("");
        try {
          const payload = cabinetV2Clone(v2DraftTask);
          payload.configVersion = v2ExpectedVersion + 1;
          await v2Bridge.applyTask(sessionId, payload, v2ExpectedVersion);
          await v2Bridge.refresh(sessionId);
          v2SetModalOpen(false); v2SetDraftTask(null);
        } catch (err) {
          v2SetErrorMessages(cabinetV2Errors(err));
        } finally {
          v2SetSaving(false);
        }
      };
      const renderV2ModeEntry = () => (0, react_jsx_runtime.jsx)("button", {
        ref: itemRef(), type: "button", role: "menuitem", "aria-haspopup": "dialog",
        "data-cabinet-v2-mode-entry": "", "aria-label": "内阁模式",
        className: ModelSelect_module_css_default.option, onClick: v2OpenConfiguration,
        children: v2IsCabinet ? "✓ 内阁模式" : "内阁模式"
      });
      const v2Modal = !v2ModalOpen ? null : react_dom.createPortal(
        react.createElement("div", {
          role: "dialog", "aria-modal": "true", "aria-label": "本任务设置",
          "data-cabinet-v2-task-modal": sessionId,
          onKeyDown: e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); v2CancelConfiguration(); } },
          onClick: e => { if (e.target === e.currentTarget) v2CancelConfiguration(); },
          style: {
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "16px", boxSizing: "border-box"
          }
        },
          react.createElement("div", {
            onClick: e => e.stopPropagation(),
            style: {
              boxSizing: "border-box",
              width: "clamp(320px, 92vw, 1260px)",
              height: "clamp(360px, 88vh, 860px)",
              maxWidth: "calc(100vw - 24px)",
              maxHeight: "calc(100vh - 24px)",
              display: "flex", flexDirection: "column",
              borderRadius: "16px",
              background: "var(--dsw-alias-bg-base, #ffffff)",
              color: "var(--dsw-alias-label-primary, #26313d)",
              border: "1px solid var(--dsw-alias-border-l2, #cdd8e5)",
              boxShadow: "0 20px 50px rgba(0, 0, 0, 0.24)",
              overflow: "hidden"
            }
          },
            react.createElement("header", {
              style: {
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "14px 22px", borderBottom: "1px solid var(--dsw-alias-border-l3, #e8edf2)"
              }
            },
              react.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 12 } },
                react.createElement("strong", { style: { fontSize: 18 } }, "内阁模式 · 本对话配置（子代）"),
                react.createElement("span", { style: { fontSize: 12, color: "#65717d" } }, "修改仅作用于当前对话，不改变全局母本")
              ),
              react.createElement("button", {
                type: "button", onClick: v2CancelConfiguration, "aria-label": "关闭",
                style: { background: "none", border: 0, fontSize: 20, lineHeight: 1, color: "#65717d", cursor: "pointer", padding: "2px 6px" }
              }, "×")
            ),
            react.createElement("div", {
              className: "cabinet-v2-modal-body",
              style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "auto", padding: "18px 22px", boxSizing: "border-box" }
            },
              v2Loading && react.createElement("p", { role: "status", style: { color: "#65717d" } }, "正在读取配置…"),
              v2NoticeText && react.createElement("div", { role: "status", style: { color: "#2d8f54", marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: "#f0faf4", border: "1px solid #b7e1c7", fontSize: 13 } }, v2NoticeText),
              v2ErrorMessages.length > 0 && react.createElement("div", { role: "alert", style: { color: "#be6262", marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: "#fdf2f2", border: "1px solid #e6b8b8", fontSize: 13 } }, v2ErrorMessages.join("；")),
              v2DraftTask && react.createElement(CabinetV2ConfigEditor, { value: v2DraftTask, onChange: v => { v2SetDraftTask(v); v2SetNoticeText(""); }, disabled: v2Saving || v2Loading, context: "task" })
            ),
            react.createElement("footer", {
              style: {
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
                padding: "12px 22px", borderTop: "1px solid var(--dsw-alias-border-l3, #e8edf2)",
                background: "var(--dsw-alias-bg-base, #ffffff)"
              }
            },
              react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                react.createElement("button", {
                  type: "button", disabled: v2Saving || v2Loading || !v2DraftTask, onClick: v2PromoteToDefaultPlan,
                  style: { padding: "8px 14px", borderRadius: 8, border: "1px solid #91acd5", background: "#edf3fd", color: "#3d609a", cursor: "pointer", fontSize: 13, fontWeight: 600 }
                }, "一键设为默认配置"),
                react.createElement("button", {
                  type: "button", disabled: v2Saving || v2Loading, onClick: v2ReloadFromDefaultPlan,
                  style: { padding: "8px 14px", borderRadius: 8, border: "1px solid #d7dee6", background: "transparent", color: "#65717d", cursor: "pointer", fontSize: 13 }
                }, "载入全局默认")
              ),
              react.createElement("div", { style: { display: "flex", gap: 10 } },
                react.createElement("button", {
                  type: "button", disabled: v2Saving, onClick: v2CancelConfiguration,
                  style: { padding: "8px 18px", borderRadius: 8, border: "1px solid #d7dee6", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14 }
                }, "取消"),
                react.createElement("button", {
                  type: "button", disabled: v2Saving || v2Loading || !v2DraftTask, onClick: v2ApplyConfiguration,
                  style: { padding: "8px 20px", borderRadius: 8, border: "1px solid #3d609a", background: "#3d609a", color: "#ffffff", cursor: "pointer", fontSize: 14, fontWeight: 600 }
                }, v2Saving ? "应用中…" : "应用到本任务")
              )
            )
          )
        ),
        document.body
      );
  `;

  source = once(source, '\t\t\tconst choose = (selection) => {\n\t\t\t\tif (state.current?.provider === selection.provider && state.current.model === selection.model) {', '\t\t\tconst choose = (selection) => {\n\t\t\t\tif (!v2IsCabinet && state.current?.provider === selection.provider && state.current.model === selection.model) {', 'choose-ordinary');
  source = once(source, 'if (effectiveEffort === effort) {', 'if (!v2IsCabinet && effectiveEffort === effort) {', 'choose-effort');
  source = once(source, 'const triggerLabel = effortLabel === void 0 ? modelLabel : `${modelLabel} · ${effortLabel}`;', 'const triggerLabel = v2IsCabinet ? "内阁模式" : effortLabel === void 0 ? modelLabel : `${modelLabel} · ${effortLabel}`;', 'trigger-label');
  source = once(source, 'children: currentChoice === void 0 ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, "trigger", true)', 'children: v2IsCabinet ? "内阁模式" : currentChoice === void 0 ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, "trigger", true)', 'trigger-text');
  source = once(source, 'effortLabel !== void 0 && (0, react_jsx_runtime.jsx)("span", {', '!v2IsCabinet && effortLabel !== void 0 && (0, react_jsx_runtime.jsx)("span", {', 'effort-hide');
  source = once(source, '\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tref: rootRef,', helpersTop + '\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tref: rootRef,', 'helpers');
  source = once(source, '\n\t\t\t\t\t\t]\n\t\t\t\t\t}), document.body),', ',\n            renderV2ModeEntry()\n\t\t\t\t\t\t]\n\t\t\t\t\t}), document.body),', 'menu-entry');
  source = once(source, '\t\t\t\t\ttoast !== null && (0, react_jsx_runtime.jsx)', '\t\t\t\t\tv2Modal,\n\t\t\t\t\ttoast !== null && (0, react_jsx_runtime.jsx)', 'modal-mount');
  source = once(source, '\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tavailable,\n\t\t\t\t\t\t\tdirectory: directory.store,', '\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tsessionId,\n\t\t\t\t\t\t\tavailable,\n\t\t\t\t\t\t\tdirectory: directory.store,', 'pass-sessionId');
  return source;
}

function patchLayout(s) {
  s = s.replace(/\r\n/g, '\n');
  s = once(s, 'const rightbarPreference = layoutInfo.rightbar ?? viewport * .45;', 'const rightbarPreference = layoutInfo.cabinetRightbarOverride ?? layoutInfo.rightbar ?? viewport * .45;', 'pref');
  s = once(s, 'rightbar: null,', 'rightbar: null,\n\t\t\t\t\t\tcabinetRightbarOverride: null,', 'init');
  s = once(s, 'openRightbar: (d, track, fullscreen) => {', 'setCabinetRightbarOverride: (d, px) => { d.layoutInfo.cabinetRightbarOverride = px === null ? null : clampWidth(px, 300, Math.max(300, d.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO)); },\n\t\t\t\t\topenRightbar: (d, track, fullscreen) => {', 'action');
  s = once(s, '/** Report the right panel\'s track and fullscreen presentation. */', 'setCabinetRightbarOverride(px) { this.panels.setCabinetRightbarOverride(px); }\n\t\t\t/** Report the right panel\'s track and fullscreen presentation. */', 'api');
  return s;
}

function patchSidebarRight(s) {
  s = s.replace(/\r\n/g, '\n');
  const readerCode = fs.readFileSync(path.join(UI_DIR, 'reader-dialog.js'), 'utf8');
  const sidebarCode = fs.readFileSync(path.join(UI_DIR, 'dashboard-sidebar.js'), 'utf8');
  s = once(s, 'function apply(ctx) {', readerCode + '\n' + sidebarCode + '\n\t\tfunction apply(ctx) {', 'dashboard-components');
  const effect = `
    ctx.effect(() => {
      const kind = "cabinet-v2", id = "cabinet-v2";
      const offType = tabs.register({ id, kind, title: () => "内阁", multiple: false });
      const offBody = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab", key: id,
        inject: sessionId => ({ collapse: () => { if (controller.mounted.getSnapshot() === sessionId) controller.toggleExpanded(); } })
      }, CabinetDashboard));
      const saved = new Map();
      let syncing = false;
      const sync = () => {
        if (syncing) return;
        syncing = true;
        try {
          const sessionId = ctx.uiSession.adapter.current.getSnapshot().key;
          const snap = window.__dshCabinetV2?.snapshot?.(sessionId);
          if (typeof sessionId !== "string" || snap?.mode !== "cabinet") {
            layout.setCabinetRightbarOverride?.(null);
            return;
          }
          layout.setCabinetRightbarOverride?.(320);
          const surface = controller.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId];
          if (surface && controller.mounted.getSnapshot() === sessionId && !saved.has(sessionId)) {
            saved.set(sessionId, true);
            controller.openTab(kind, { preferNewPane: false });
          }
        } finally { syncing = false; }
      };
      const offCur = ctx.uiSession.adapter.current.subscribe(sync);
      const offMnt = controller.mounted.subscribe(sync);
      window.addEventListener("dsh-cabinet-v2-state", sync);
      sync();
      return () => { offCur(); offMnt(); window.removeEventListener("dsh-cabinet-v2-state", sync); offBody(); offType(); };
    }, "cabinet clean sidebar");
  `;
  const anchor = '\t\t}\n\t\t//#endregion\n\t\texports.apply = apply;';
  return once(s, anchor, effect + anchor, 'sidebar-effect');
}

function patchChat(s) {
  s = s.replace(/\r\n/g, '\n');
  const REGION = '\t\t//#region lib/types/client/chat/AssistantNodeView.js\n';
  const ORIGINAL_RETURN = `\t\t\treturn (0, react_jsx_runtime.jsx)(AssistantMarkdown, {
\t\t\t\tblocks: data.blocks,
\t\t\t\tgroupPart,
\t\t\t\tuseDisclosure,
\t\t\t\tstreaming: data.status === "running",
\t\t\t\ttextInteractionSource: data.status === "settled" && data.finalNode?.messageId !== void 0,
\t\t\t\tinterrupted: data.status === "interrupted",
\t\t\t\tloadImage,
\t\t\t\treasoningHidden,
\t\t\t\tuseGroupAction,
\t\t\t\tusePresentation,
\t\t\t\trenderSlot,
\t\t\t\trevealProcess,
\t\t\t\tmentions,
\t\t\t\tt
\t\t\t});`;
  const headerComp = `
    function CabinetPhaseMessageHeader({ sessionId, messageId }) {
      const H = react.createElement;
      const snap = globalThis.__dshCabinetV2?.snapshot?.(sessionId);
      const orig = (snap?.collaboration?.originals ?? []).find(o => o.sourceId === messageId || o.messageId === messageId);
      if (!orig) return null;
      return H("div", { "data-cabinet-phase-message-header": orig.role || "worker", style: { fontSize: 12, color: "#3d609a", fontWeight: 600, marginBottom: 6 } },
        (orig.roleBadge || orig.role || "内阁") + " · " + (orig.actorLabel || orig.modelId || "")
      );
    }
  `;
  const origExpr = ORIGINAL_RETURN.trim().slice('return '.length, -1);
  const rep = `\t\t\treturn (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [
\t\t\t\tgroupPart !== "reasoning" && (0, react_jsx_runtime.jsx)(CabinetPhaseMessageHeader, { sessionId, messageId: data.finalNode?.messageId }),
\t\t\t\t${origExpr}
\t\t\t] });`;
  return once(once(s, ORIGINAL_RETURN, rep, 'chat-return'), REGION, REGION + headerComp + '\n', 'chat-header');
}

function patchSettingsSection(source) {
  source = source.replace(/\r\n/g, '\n');
  const canvasCode = fs.readFileSync(path.join(UI_DIR, 'canvas-editor.js'), 'utf8');
  const rawClient = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib/client.js'), 'utf8');
  const innerStart = rawClient.indexOf('var PACKAGE_ID = "dsh-cabinet";');
  const innerEnd = rawClient.lastIndexOf('function apply(ctx) {');
  const definitions = rawClient.slice(innerStart, innerEnd);

  const regCode = `
    installStyles();
    if (!globalThis.__dshCabinetSettingsRegistered) {
      globalThis.__dshCabinetSettingsRegistered = true;
      ctx.slots.inject(SETTINGS_ICON_SLOT, function () {
        return ctx.slots.register({ name: SETTINGS_ICON_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: function () { return "内阁模式"; } }, SettingsNavIcon);
      });
      ctx.slots.inject(SETTINGS_SLOT, function () {
        return ctx.slots.register({ name: SETTINGS_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: function () { return "内阁模式"; } }, CabinetSettingsPage);
      });
    }
  `;
  const helpersHeader = 'var React = react;\n' + canvasCode + '\n' + definitions + '\n';
  return once(source, '\t\tfunction apply(ctx) {', helpersHeader + '\t\tfunction apply(ctx) {\n' + regCode, 'root-settings-section');
}

function syncPluginToProfile() {
  const destDir = path.join(FORMAL_PROFILE, 'node_modules/dsh-cabinet');
  const legacyDir = path.join(FORMAL_PROFILE, 'node_modules/cabinet-v2-host');
  if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true });

  fs.mkdirSync(path.join(destDir, 'lib/ui'), { recursive: true });
  for (const f of ['package.json', 'cordis.patch.yml']) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, f), path.join(destDir, f));
  }
  for (const f of ['README.md', 'CHANGELOG.md']) {
    if (fs.existsSync(path.join(PLUGIN_ROOT, f))) fs.copyFileSync(path.join(PLUGIN_ROOT, f), path.join(destDir, f));
  }
  for (const f of ['index.js', 'index.mjs', 'client.js', 'memory-router.mjs', 'model-catalog.mjs', 'llm-bridge.mjs', 'session-manager.mjs', 'orchestrator.mjs']) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'lib', f), path.join(destDir, 'lib', f));
  }
  for (const f of ['client-bridge.js', 'canvas-editor.js', 'dashboard-sidebar.js', 'reader-dialog.js']) {
    fs.copyFileSync(path.join(UI_DIR, f), path.join(destDir, 'lib/ui', f));
  }

  const pluginVer = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version || '0.1.0';
  const desktopPkgFile = path.join(FORMAL_PROFILE, 'package.json');
  if (fs.existsSync(desktopPkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(desktopPkgFile, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies['dsh-cabinet'] = pluginVer;
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (!bundles.includes('dsh-cabinet')) bundles.push('dsh-cabinet');
    pkg.dsh.profile.bundles = bundles;
    fs.writeFileSync(desktopPkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return { destDir, pluginVer };
}

function installCabinet() {
  const profileSync = syncPluginToProfile();
  const result = {
    action: 'install',
    at: new Date().toISOString(),
    version: profileSync.pluginVer,
    pluginRepo: PLUGIN_ROOT,
    installedPluginDir: profileSync.destDir,
    mode: 'pure-bundle-external'
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function rollbackHostToVanilla() {
  const desktopPkgFile = path.join(FORMAL_PROFILE, 'package.json');
  if (fs.existsSync(desktopPkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(desktopPkgFile, 'utf8'));
    if (pkg.dependencies) delete pkg.dependencies['dsh-cabinet'];
    if (pkg.dsh?.profile?.bundles && Array.isArray(pkg.dsh.profile.bundles)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== 'dsh-cabinet');
    }
    fs.writeFileSync(desktopPkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  fs.rmSync(path.join(FORMAL_PROFILE, 'node_modules/dsh-cabinet'), { recursive: true, force: true });
  fs.rmSync(path.join(FORMAL_PROFILE, 'node_modules/cabinet-v2-host'), { recursive: true, force: true });
  const result = {
    action: 'uninstall-to-vanilla',
    at: new Date().toISOString(),
    mode: 'pure-bundle-external'
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  const cmd = process.argv[2] || '--install';
  if (cmd === '--uninstall') rollbackHostToVanilla();
  else installCabinet();
}

module.exports = { installCabinet, rollbackHostToVanilla, syncPluginToProfile };



