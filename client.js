/**
 * 经验库控制台（dsh-engram client 半）
 *
 * 八个页面覆盖内核全部能力：概览 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置。
 * 只通过 `/exp-ui/api/*` 访问数据；mock 与 live 返回形状一致。
 */

window.__ModuleLoader__.load({
  id: 'dsh-engram',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'exp-ui'
    const PACKAGE_NAME = 'dsh-engram'
    const TITLE = '经验库'
    const API = '/exp-ui/api'

    const STYLE_ID = 'dsh-engram/styles'

    /** 诊断回打：不同阶段各打一次，host 的 /health 会按顺序记下来。 */
    function reportProbe(phase, extra = {}) {
      try {
        const query = new URLSearchParams({ client: '1', phase, id: PACKAGE_NAME })
        for (const [key, value] of Object.entries(extra)) query.set(key, String(value))
        fetch(`${API}/health?${query.toString()}`).catch(() => {})
      } catch {
        // 测试环境没有 fetch
      }
    }

    const PANEL_CSS = `
.eng-app, .eng-app *, .eng-app *::before, .eng-app *::after { box-sizing: border-box; }
.eng-app { --eng-ok: #1f9d63; --eng-warn: #c08312; --eng-bad: #d24b45; display: flex; width: 100%; max-width: 100%; box-sizing: border-box; height: 100%; max-height: 100%; min-height: 0; overflow: hidden; container-type: inline-size; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.eng-rail { width: 208px; flex: 0 0 208px; display: flex; flex-direction: column; gap: 3px; padding: 16px 12px; overflow-y: auto; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, var(--dsw-alias-bg-layer-2)); }
.eng-brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 16px; }
.eng-brand-mark { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.eng-brand-name { font-size: 14px; font-weight: 650; letter-spacing: .2px; }
.eng-brand-sub { margin-top: 1px; font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.eng-nav { display: flex; flex-direction: column; gap: 2px; }
.eng-nav-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; text-align: left; cursor: pointer; }
.eng-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.eng-nav-item[data-active="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.eng-nav-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.eng-nav-count { margin-left: auto; font-size: 11px; opacity: .72; font-variant-numeric: tabular-nums; }
.eng-rail-foot { margin-top: auto; padding: 12px 10px 2px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.eng-main { flex: 1 1 auto; min-width: 0; width: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.eng-top { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 24px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 86%, transparent); backdrop-filter: blur(10px); }
.eng-title { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: .1px; }
.eng-sub { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.eng-top-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.eng-modal-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .34); }
.eng-modal { width: min(660px, 100%); max-height: min(760px, 88vh); overflow: auto; padding: 18px 20px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 18px 48px rgba(0, 0, 0, .2); }
.eng-modal-title { margin: 0 0 4px; font-size: 15px; font-weight: 650; }
.eng-modal-warn { margin: 12px 0 14px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-interactive-bg-hover); font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.eng-modal-warn b { color: var(--dsw-alias-label-primary); font-weight: 620; }
.eng-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.eng-git-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-interactive-bg-hover); font-size: 12px; }
/* 「添加技能」的拖拽落区：虚线框 + 中间提示，拖进来时高亮 */
.eng-dropzone { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; margin: 14px 0 12px; padding: 26px 18px; border: 1.5px dashed var(--dsw-alias-border-l2, var(--dsw-alias-border-l1)); border-radius: 14px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent); text-align: center; cursor: pointer; transition: border-color .15s ease, background .15s ease; }
.eng-dropzone:hover { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l2, var(--dsw-alias-border-l1))); }
.eng-dropzone[data-dragging="true"] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.eng-dropzone-title { font-size: 15px; font-weight: 650; letter-spacing: .2px; }
.eng-dropzone-sub { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.eng-dropzone-actions { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.eng-dropzone-link { padding: 0; border: 0; background: none; font: inherit; font-size: 12px; color: var(--dsw-alias-brand-primary); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.eng-dropzone-file { margin-top: 4px; padding: 3px 10px; border-radius: 999px; font-size: 12px; color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.eng-fixed-target { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-size: 12px; }
.eng-fixed-target code { padding: 3px 8px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover); }
.eng-req { margin: 10px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.9; color: var(--dsw-alias-label-secondary); }
.eng-content { flex: 1 1 auto; width: 100%; max-width: min(1180px, 100%); min-height: 0; margin: 0 auto; padding: clamp(12px, 2.4vw, 24px); overflow-y: auto; overflow-x: auto; }
.eng-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.eng-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
.eng-card { min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); }
.eng-kpi { display: flex; flex-direction: column; gap: 4px; padding: 15px 17px; }
.eng-kpi-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.eng-kpi-value { font-size: 26px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.eng-kpi-unit { margin-left: 4px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.eng-section { margin-top: 18px; }
.eng-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.eng-section-title { margin: 0; font-size: 13px; font-weight: 650; }
.eng-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.eng-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.eng-btn:hover { border-color: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, var(--dsw-alias-border-l1)); background: var(--dsw-alias-interactive-bg-hover); }
.eng-btn:disabled { opacity: .45; cursor: not-allowed; }
.eng-btn-primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.eng-btn-primary:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 86%, #000); }
.eng-btn-danger { color: var(--eng-bad); }
.eng-btn-sm { height: 26px; padding: 0 9px; font-size: 11px; }
.eng-input, .eng-select, .eng-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 7px 10px; }
.eng-input:focus, .eng-select:focus, .eng-textarea:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); outline-offset: 0; border-color: var(--dsw-alias-brand-primary); }
.eng-textarea { min-height: 84px; resize: vertical; line-height: 1.55; }
.eng-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.eng-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .03em; }
.eng-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
.eng-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eng-badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.eng-list { display: flex; flex-direction: column; }
.eng-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 92px 96px; gap: 10px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); cursor: pointer; }
.eng-row:last-child { border-bottom: 0; }
.eng-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.eng-row[data-on="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.eng-row-main { min-width: 0; }
.eng-row-intent { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 560; }
.eng-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.eng-mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; }
.eng-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.eng-table th { padding: 8px 10px; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .05em; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.eng-table td { padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.eng-table tr:last-child td { border-bottom: 0; }
.eng-scroll .eng-table thead th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-2); }
.eng-tip { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: 4px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 600; line-height: 1; cursor: help; vertical-align: middle; }
.eng-tip:hover, .eng-tip:focus-visible { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); outline: none; }
.eng-tip-bubble { display: none; position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%); z-index: 30; width: max-content; max-width: 300px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 96%, transparent); color: var(--dsw-alias-label-primary); font-size: 11px; line-height: 1.55; box-shadow: 0 8px 24px rgba(0,0,0,.18); pointer-events: none; }
.eng-tip:hover .eng-tip-bubble, .eng-tip:focus-visible .eng-tip-bubble { display: block; }.eng-subnav { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.eng-subnav-item { padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.eng-subnav-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.eng-subnav-item[data-active="true"] { border-color: transparent; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 600; }.eng-git-repos { max-height: 240px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; margin-bottom: 10px; }
.eng-git-repo { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.eng-git-repo:last-child { border-bottom: 0; }.eng-empty { padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.eng-banner { margin-bottom: 14px; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent); color: var(--dsw-alias-label-secondary); font-size: 12px; }
.eng-banner-bad { border-color: color-mix(in srgb, var(--eng-bad) 40%, var(--dsw-alias-border-l1)); color: var(--eng-bad); }
.eng-detail { padding: 16px; }
.eng-detail-title { font-size: 14px; font-weight: 650; margin: 0 0 4px; }
.eng-kv { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 6px 10px; font-size: 12px; }
.eng-kv dt { color: var(--dsw-alias-label-secondary); }
.eng-kv dd { margin: 0; word-break: break-word; }
.eng-pre { margin: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.eng-chipbar { display: flex; gap: 6px; flex-wrap: wrap; }
.eng-chip { padding: 3px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.eng-chip[data-on="true"] { border-color: transparent; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.eng-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.eng-toolbar .eng-input { width: min(220px, 100%); }
.eng-toolbar .eng-select { width: min(140px, 100%); }
.eng-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; align-items: start; }
.eng-stack { display: flex; flex-direction: column; gap: 12px; }
.eng-skill-row { padding: 13px 15px; display: flex; gap: 12px; align-items: flex-start; cursor: pointer; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.eng-skill-row:last-child { border-bottom: 0; }
.eng-skill-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.eng-skill-row[data-on="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }
.eng-skill-name { font-weight: 620; }
.eng-skill-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.eng-nav-sep { height: 1px; margin: 10px 8px; background: var(--dsw-alias-border-l1); }
@container (max-width: 980px) { .eng-cols, .eng-split { grid-template-columns: minmax(0, 1fr); } .eng-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .eng-split[data-open="true"] > .eng-detail-card { order: -1; } }
@container (max-width: 680px) { .eng-rail { width: 100%; flex: 0 0 auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); overflow: visible; } .eng-brand { padding: 0 10px 0 2px; } .eng-brand-sub { display: none; } .eng-nav { flex-direction: row; flex-wrap: wrap; } .eng-nav-item { width: auto; padding: 6px 9px; } .eng-nav-count, .eng-rail-foot, .eng-nav-sep { display: none; } .eng-content { padding: 14px; } .eng-top { padding: 10px 14px; } .eng-form-grid { grid-template-columns: minmax(0, 1fr); } .eng-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 1180px) { .eng-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .eng-cols, .eng-split { grid-template-columns: minmax(0, 1fr); } .eng-split[data-open="true"] > .eng-detail-card { order: -1; } }
@media (max-width: 860px) { .eng-app { flex-direction: column; } .eng-rail { width: 100%; flex: 0 0 auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); } .eng-brand { padding: 0 10px 0 2px; } .eng-brand-sub { display: none; } .eng-nav { flex-direction: row; flex-wrap: wrap; } .eng-nav-item { width: auto; padding: 6px 9px; } .eng-nav-count, .eng-rail-foot, .eng-nav-sep { display: none; } .eng-content { padding: 14px; } .eng-top { padding: 10px 14px; } .eng-form-grid { grid-template-columns: minmax(0, 1fr); } }
.eng-split[data-open="true"] .eng-stack > .eng-detail-card { order: -1; }
/* 控制台所有页：抬头 / 表单 / 子导航留在原位，长内容在自己的窗口里滚，不再整页拖走 */
.eng-content[data-fill="true"] { display: flex; flex-direction: column; overflow: hidden; }
.eng-content[data-fill="true"] > .eng-fill { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.eng-content[data-fill="true"] > .eng-fill > .eng-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
.eng-content[data-fill="true"] > .eng-fill > .eng-split { flex: 1 1 auto; min-height: 0; align-items: stretch; grid-auto-rows: minmax(0, 1fr); }
.eng-content[data-fill="true"] > .eng-fill > .eng-split > * { min-height: 0; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
@media (max-width: 1180px) {
  .eng-content[data-fill="true"] { overflow-y: auto; }
  .eng-content[data-fill="true"] > .eng-fill { display: block; }
  .eng-content[data-fill="true"] > .eng-fill > .eng-scroll { overflow: visible; }
  .eng-content[data-fill="true"] > .eng-fill > .eng-split { grid-auto-rows: auto; }
  .eng-content[data-fill="true"] > .eng-fill > .eng-split > * { max-height: none; overflow: visible; }
}
@container (max-width: 980px) {
  .eng-content[data-fill="true"] { overflow-y: auto; }
  .eng-content[data-fill="true"] > .eng-fill { display: block; }
  .eng-content[data-fill="true"] > .eng-fill > .eng-scroll { overflow: visible; }
  .eng-content[data-fill="true"] > .eng-fill > .eng-split { grid-auto-rows: auto; }
  .eng-content[data-fill="true"] > .eng-fill > .eng-split > * { max-height: none; overflow: visible; }
}
@keyframes eng-dash { to { stroke-dashoffset: -10; } }
.eng-graph-canvas-wrap { position: relative; width: 100%; aspect-ratio: 16 / 9; min-height: 420px; overflow: hidden; border-radius: 12px; background: transparent; }
.eng-graph-canvas { width: 100%; height: 100%; display: block; cursor: grab; }
.eng-content-full { padding: 0; max-width: none; overflow: hidden; display: flex; }
.eng-content-full .eng-graph-canvas-wrap { flex: 1 1 auto; height: 100%; min-height: 0; aspect-ratio: auto; border-radius: 0; }
.eng-graph-detail { position: absolute; right: 14px; bottom: 14px; z-index: 2; width: min(320px, 72%); padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent); backdrop-filter: blur(10px); box-shadow: 0 10px 30px rgba(0,0,0,.14); }
.eng-graph-detail-title { font-size: 13px; font-weight: 650; margin: 0 0 6px; word-break: break-word; }
.eng-graph-detail-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
/* 关系图右上角配色胶囊：跟随主题 / 蓝紫星辰（dsh-codex-effort-slider 的渐变） */
.eng-graph-pill { position: absolute; top: 14px; right: 14px; z-index: 3; display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent); backdrop-filter: blur(10px); box-shadow: 0 6px 18px rgba(0,0,0,.10); }
.eng-graph-pill button { border: 0; border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 12px; line-height: 1.2; color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer; white-space: nowrap; }
.eng-graph-pill button:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.eng-graph-pill button[data-active="true"] { color: #fff; background: var(--dsw-alias-brand-primary); }
.eng-graph-pill button[data-tone="codex"][data-active="true"] { background: linear-gradient(90deg, #4d93f8 0%, #6d28d9 42%, #9333ea 74%, #c084fc 100%); }
`
    function ensureStyles() {
      try {
        if (document.getElementById(STYLE_ID)) return
        const node = document.createElement('style')
        node.id = STYLE_ID
        node.textContent = PANEL_CSS
        document.head.appendChild(node)
      } catch {
        // 无 document 的测试环境：跳过样式注入
      }
    }

    const TONES = {
      ok: { color: 'var(--eng-ok)', bg: 'color-mix(in srgb, var(--eng-ok) 14%, transparent)' },
      warn: { color: 'var(--eng-warn)', bg: 'color-mix(in srgb, var(--eng-warn) 14%, transparent)' },
      bad: { color: 'var(--eng-bad)', bg: 'color-mix(in srgb, var(--eng-bad) 14%, transparent)' },
      muted: { color: 'var(--dsw-alias-label-secondary)', bg: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent)' },
      brand: { color: 'var(--dsw-alias-brand-primary)', bg: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent)' },
    }

    const OUTCOMES = {
      success: ['成功', 'ok'], accepted: ['通过', 'ok'], partial: ['部分', 'warn'],
      failed: ['失败', 'bad'], corrected: ['被纠正', 'bad'], rejected: ['被拒', 'bad'],
      aborted: ['中止', 'muted'], unknown: ['未标', 'muted'],
    }
    const SKILL_STATES = {
      solid: ['已固化', 'ok'], trial: ['试用中', 'warn'], risky: ['不稳定', 'bad'],
      blocked: ['有未解障碍', 'bad'], new: ['待验证', 'muted'],
    }

    function outcomeOf(value) {
      return OUTCOMES[String(value || 'unknown')] || [String(value || '未标'), 'muted']
    }
    function skillStateOf(value) {
      return SKILL_STATES[String(value || 'new')] || [String(value || '待验证'), 'muted']
    }
    function fmtNumber(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return (Math.round(number * 100) / 100).toString()
    }
    function fmtBytes(value) {
      const bytes = Number(value) || 0
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }
    function fmtTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    async function request(path, options = {}) {
      const init = { method: options.method || 'GET', headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(`${API}${path}`, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!payload || payload.ok !== true) {
        const error = new Error((payload && payload.error && payload.error.message) || `请求失败（HTTP ${response.status}）`)
        error.code = payload && payload.error ? payload.error.code : 'http'
        throw error
      }
      return payload.data
    }

    function Badge(props) {
      const tone = TONES[props.tone] || TONES.muted
      return h('span', { className: 'eng-badge', style: { color: tone.color, background: tone.bg } }, props.children)
    }
    function Button(props) {
      const kind = props.kind === 'primary' ? 'eng-btn eng-btn-primary' : props.kind === 'danger' ? 'eng-btn eng-btn-danger' : 'eng-btn'
      return h('button', { type: 'button', className: `${kind}${props.small ? ' eng-btn-sm' : ''}`, disabled: props.disabled, onClick: props.onClick, title: props.title }, props.children)
    }
    /** 悬浮说明：问号图标，悬停/键盘聚焦时弹气泡（用于有歧义的设置项）。 */
    function Tip(props) {
      const text = String(props.text || '')
      if (text === '') return null
      return h('span', { className: 'eng-tip', tabIndex: 0, role: 'note', 'aria-label': text },
        '?',
        h('span', { className: 'eng-tip-bubble', role: 'tooltip' }, text))
    }
    function Field(props) {
      return h('div', { className: 'eng-field', style: props.wide ? { gridColumn: '1 / -1' } : undefined },
        props.label ? h('label', { className: 'eng-label' }, props.label, props.tip ? h(Tip, { text: props.tip }) : null) : null,
        props.children,
        props.hint ? h('span', { className: 'eng-muted' }, props.hint) : null)
    }
    function Empty(props) {
      return h('div', { className: 'eng-empty' }, props.children || '暂无数据')
    }
    /** 经验库自己的标记：双侧记忆弧 + 中心节点（侧栏、品牌位、卡片共用一套）。 */
    /** 经验库标记（B：记忆螺旋）——外圈收进内圈，中心一点；侧栏、面板头、卡片共用。 */
    function EngramGlyph(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      const weight = props && Number(props.strokeWidth) > 0 ? Number(props.strokeWidth) : 1.25
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: weight,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M8 2.6A5.4 5.4 0 1 1 3.07 10.7' }),
        h('path', { d: 'M8 5.2A2.8 2.8 0 1 1 5.44 9.4' }),
        h('circle', { cx: 8, cy: 8, r: 1.05, fill: 'currentColor', stroke: 'none' }))
    }

    function NavIcon(props) {
      const paths = {
        overview: 'M2 7.2 8 2l6 5.2V14H9.8v-4H6.2v4H2V7.2Z',
        book: 'M3 2.8h7.2A2.8 2.8 0 0 1 13 5.6V13H5.4A2.4 2.4 0 0 0 3 15.4V2.8Z',
        search: 'M7.2 12.4a5.2 5.2 0 1 1 0-10.4 5.2 5.2 0 0 1 0 10.4Zm4-1.2L15 15',
        plus: 'M8 3v10M3 8h10',
        spark: 'M8 1.8l1.7 4.1 4.4.4-3.4 2.9 1 4.3L8 11.4l-3.7 2.1 1-4.3L1.9 6.3l4.4-.4L8 1.8Z',
        tag: 'M2 3h5.6l6.4 6.4-4.6 4.6L3 7.6V3Zm2.6 2.4h.01',
        clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm0-9v3.4l2.3 1.4',
        graph: 'M3 3h3v3H3V3Zm7 7h3v3h-3v-3ZM3 13h3v3H3v-3Zm4-9h3M6 6l3 3m2 4h3M14 10l-3-3',
        gear: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Zm5.4-2.2c0-.5-.1-.9-.2-1.3l1.5-1.1-1.4-2.4-1.8.7c-.6-.5-1.3-.9-2-1.2L9.2 1H6.8l-.3 1.7c-.7.3-1.4.7-2 1.2l-1.8-.7L1.3 5.6l1.5 1.1c-.1.4-.2.8-.2 1.3s.1.9.2 1.3L1.3 10.4l1.4 2.4 1.8-.7c.6.5 1.3.9 2 1.2l.3 1.7h2.4l.3-1.7c.7-.3 1.4-.7 2-1.2l1.8.7 1.4-2.4-1.5-1.1c.1-.4.2-.8.2-1.3Z',
      }
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: '0 0 auto', opacity: .9 } },
        h('path', { d: paths[props.name] || paths.overview }))
    }

    function useLoad(loader) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          setData(await loader())
        } catch (caught) {
          setError(caught && caught.message ? caught.message : String(caught))
        } finally {
          setLoading(false)
        }
      }, [loader])
      useEffect(() => { load() }, [load])
      return { data, error, loading, reload: load, setData }
    }

    function Banner(props) {
      return h('div', { className: `eng-banner${props.bad ? ' eng-banner-bad' : ''}` }, props.children)
    }

    function Overview(props) {
      const recent = useLoad(useCallback(() => request('/experiences?limit=6'), []))
      const state = props.state || {}
      const totals = state.totals || {}
      const usage = state.usage || {}
      const summary = state.skillSummary || {}
      const kpis = [
        ['可见经验', totals.visible, '条'],
        ['固化技能', totals.skills, '个'],
        ['今日调用', usage.today, '次'],
        ['库大小', fmtBytes(state.bytes), ''],
      ]
      return h('div', { className: 'eng-fill' },
        h('div', { className: 'eng-scroll' },
        h('div', { className: 'eng-grid' }, kpis.map(([label, value, unit]) => h('div', { key: label, className: 'eng-card eng-kpi' },
          h('span', { className: 'eng-kpi-label' }, label),
          h('span', { className: 'eng-kpi-value' }, value === undefined ? '—' : String(value), h('span', { className: 'eng-kpi-unit' }, unit))))),
        h('div', { className: 'eng-cols eng-section' },
          h('div', { className: 'eng-card' },
            h('div', { style: { padding: '13px 15px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('h3', { className: 'eng-section-title' }, '最近经验'),
              h(Button, { small: true, onClick: () => props.onGo('experiences') }, '全部')),
            recent.error ? h(Banner, { bad: true }, recent.error) : null,
            recent.data && recent.data.rows && recent.data.rows.length > 0
              ? h('div', { className: 'eng-list' }, recent.data.rows.slice(0, 6).map((row) => {
                const [label, tone] = outcomeOf(row.outcome)
                return h('div', { key: row.id, className: 'eng-row', style: { gridTemplateColumns: '60px minmax(0,1fr) 70px' }, onClick: () => props.onOpen(row.id) },
                  h(Badge, { tone }, label),
                  h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || '（无意图）'), h('div', { className: 'eng-row-sub' }, `${row.typeName || '未分类'} · ${row.action || '—'}`)),
                  h('span', { className: 'eng-mono', style: { textAlign: 'right' } }, `G ${fmtNumber(row.G)}`))
              }))
              : h(Empty, null, recent.loading ? '读取中…' : '还没有经验：去「记录」写第一条。')),
          h('div', { className: 'eng-stack' },
            h('div', { className: 'eng-card', style: { padding: 15 } },
              h('h3', { className: 'eng-section-title', style: { marginBottom: 10 } }, '快捷操作'),
              h('div', { className: 'eng-actions' },
                h(Button, { kind: 'primary', onClick: () => props.onGo('record') }, '记录经验'),
                h(Button, { onClick: () => props.onGo('recall') }, '检索召回'),
                h(Button, { onClick: () => props.onGo('skills') }, '沉淀技能'))),
            h('div', { className: 'eng-card', style: { padding: 15 } },
              h('h3', { className: 'eng-section-title', style: { marginBottom: 10 } }, '技能状态'),
              h('div', { className: 'eng-chipbar' }, ['solid', 'trial', 'risky', 'blocked', 'new'].map((key) => {
                const [label, tone] = skillStateOf(key)
                return h(Badge, { key, tone }, `${label} ${summary[key] || 0}`)
              })),
              h('div', { className: 'eng-muted', style: { marginTop: 10 } }, state.notice || `共 ${totals.types || 0} 个类型`))))))
    }

    function Experiences(props) {
      const [searchDraft, setSearchDraft] = useState('')
      const [type, setType] = useState('')
      const [outcome, setOutcome] = useState('')
      const [selected, setSelected] = useState(null)
      const detailRef = useRef(null)
      const list = useLoad(useCallback(() => {
        const params = new URLSearchParams({ limit: '100' })
        if (type !== '') params.set('type', type)
        if (outcome !== '') params.set('outcome', outcome)
        return request(`/experiences?${params.toString()}`)
      }, [type, outcome]))
      const detail = useLoad(useCallback(() => selected === null ? Promise.resolve(null) : request(`/experience?id=${encodeURIComponent(selected)}`), [selected]))
      // 窄面板下列表与详情会被压成一列：选中后把详情卡片滚进视野，否则看起来「点了没反应」。
      useEffect(() => {
        const node = detailRef.current
        if (selected === null || node === null || typeof node.scrollIntoView !== 'function') return
        node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, [selected, detail.data])
      const types = (props.state && props.state.types) || []
      const rows = (list.data && (list.data.rows || list.data.candidates)) || []
      const send = async (result) => {
        if (selected === null) return
        await request('/feedback', { method: 'POST', body: { id: selected, result } })
        await Promise.all([list.reload(), detail.reload()])
        props.onChanged()
      }
      return h('div', { className: 'eng-fill' },
        list.error ? h(Banner, { bad: true }, list.error) : null,
        h('div', { className: 'eng-toolbar' },
          h('input', { className: 'eng-input', placeholder: '按意图检索（回车跳到检索页）…', value: searchDraft, onChange: (event) => setSearchDraft(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && searchDraft.trim() !== '') props.onSearch(searchDraft.trim()) } }),
          h('select', { className: 'eng-select', value: type, onChange: (event) => setType(event.target.value) },
            h('option', { value: '' }, '全部类型'), types.map((item) => h('option', { key: item.id, value: item.id }, item.name))),
          h('select', { className: 'eng-select', value: outcome, onChange: (event) => setOutcome(event.target.value) },
            h('option', { value: '' }, '全部结果'), Object.keys(OUTCOMES).map((key) => h('option', { key, value: key }, OUTCOMES[key][0]))),
          h('span', { className: 'eng-muted' }, `${list.data ? list.data.total : '—'} 条`),
          h(Button, { small: true, disabled: searchDraft.trim() === '', onClick: () => props.onSearch(searchDraft.trim()) }, '检索'),
          h(Button, { small: true, disabled: list.loading, onClick: list.reload }, list.loading ? '刷新中…' : '刷新')),
        h('div', { className: 'eng-split', 'data-open': selected === null ? 'false' : 'true' },
          h('div', { className: 'eng-card' },
            rows.length === 0 ? h(Empty, null, list.loading ? '读取中…' : '没有符合条件的经验') : h('div', { className: 'eng-list' }, rows.map((row) => {
              const [label, tone] = outcomeOf(row.outcome)
              return h('div', { key: row.id, className: 'eng-row', 'data-on': selected === row.id ? 'true' : 'false', onClick: () => setSelected(row.id) },
                h(Badge, { tone }, label),
                h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || '（无意图）'), h('div', { className: 'eng-row-sub' }, `${row.typeName || '未分类'} · ${row.action || '—'}`)),
                h('span', { className: 'eng-mono' }, `G ${fmtNumber(row.G)}`),
                h('span', { className: 'eng-muted' }, fmtTime(row.lastSeenAt || row.ts)))
            }))),
          h('div', { className: 'eng-card eng-detail-card', ref: detailRef },
            h(DetailPane, { selected, detail, send, onClose: () => setSelected(null) }))))
    }

    /**
     * 右侧详情面板。单独抽成组件：既让「选中 → 详情」有可渲染的单元测试，
     * 也避免再出现「内联立即执行函数漏了调用、React 收到函数子节点渲染空白」那类事故。
     */
    function DetailPane(props) {
      const { selected, detail, send, onClose } = props
      if (selected === null) return h(Empty, null, '选一条经验看详情')
      if (detail && detail.error) return h(Banner, { bad: true }, detail.error)
      const data = detail ? detail.data : null
      if (data === null || data === undefined || !data.row) return h(Empty, null, '读取中…')
      const row = data.row
      const [label, tone] = outcomeOf(row.outcome)
      return h('div', { className: 'eng-detail' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } }, h(Badge, { tone }, label), h('span', { className: 'eng-mono' }, `G ${fmtNumber(row.G)}`)),
        h('h3', { className: 'eng-detail-title' }, row.intent || '（无意图）'),
        h('dl', { className: 'eng-kv' },
          h('dt', null, '做法'), h('dd', null, row.action || '—'),
          h('dt', null, '类型'), h('dd', null, row.typeName || '—'),
          h('dt', null, '任务'), h('dd', null, row.kind === 'step' ? `步骤 ${row.stepIndex || '?'} / ${row.stepTotal || '?'}` : (row.kind || '整条')),
          h('dt', null, '情境'), h('dd', null, Array.isArray(row.context) && row.context.length ? row.context.join('、') : '—'),
          h('dt', null, '反馈'), h('dd', null, row.feedback ? `有帮助 ${row.feedback.helped || 0} / 没帮上 ${row.feedback.hurt || 0}` : '—'),
          h('dt', null, 'id'), h('dd', { className: 'eng-mono' }, row.id)),
        row.note ? h('div', { style: { marginTop: 12 } }, h('div', { className: 'eng-label', style: { marginBottom: 5 } }, '备注'), h('div', { className: 'eng-pre' }, row.note)) : null,
        h('div', { className: 'eng-actions', style: { marginTop: 14 } },
          h(Button, { small: true, onClick: () => send('helped') }, '有帮助'),
          h(Button, { small: true, onClick: () => send('hurt') }, '没帮上'),
          h(Button, { small: true, onClick: () => send('neutral') }, '中性'),
          h(Button, { small: true, onClick: () => onClose() }, '收起')))
    }

    function Recall(props) {
      const [intent, setIntent] = useState((props && props.seed) || '')
      const [context, setContext] = useState('')
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const run = async () => {
        setBusy(true); setError('')
        try {
          setResult(await request('/recall', { method: 'POST', body: { intent, context: context.trim() === '' ? [] : context.split(/[,，]/).map((item) => item.trim()).filter(Boolean), limit: 8 } }))
        } catch (caught) {
          setError(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      const feedback = async (id, value) => {
        try {
          await request('/feedback', { method: 'POST', body: { id, result: value } })
          await run()
        } catch (caught) {
          setError(caught.message || String(caught))
        }
      }
      const candidates = result ? (result.candidates || result.rows || []) : []
      const engineShape = candidates.some((item) => Array.isArray(item.evidence))
      return h('div', { className: 'eng-fill' },
        error ? h(Banner, { bad: true }, error) : null,
        h('div', { className: 'eng-card', style: { padding: 16, marginBottom: 14 } },
          h('div', { className: 'eng-form-grid' },
            h(Field, { label: '意图', wide: true, hint: '走内核 JitRL 召回（技能模式优先返回技能正文）' },
              h('textarea', { className: 'eng-textarea', placeholder: '例如：把课件导出成 PDF，字体要嵌进去', value: intent, onChange: (event) => setIntent(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) run() } })),
            h(Field, { label: '情境（逗号分隔，可选）' }, h('input', { className: 'eng-input', placeholder: 'windows, powerpoint', value: context, onChange: (event) => setContext(event.target.value) }))),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy || intent.trim() === '', onClick: run }, busy ? '检索中…' : '检索'))),
        h('div', { className: 'eng-scroll' },
          result === null ? h(Empty, null, '输入意图后点「检索」，候选会出现在这里') : h('div', null,
          h('div', { className: 'eng-actions', style: { marginBottom: 12 } },
            h(Badge, { tone: result.mode === 'skill' ? 'brand' : result.mode === 'advantage' ? 'ok' : 'muted' }, `mode=${result.mode}`),
            h('span', { className: 'eng-muted' }, `候选 ${candidates.length} 组`),
            result.pendingSkills ? h(Badge, { tone: 'warn' }, `待补提交 ${result.pendingSkills}`) : null),
          result.brief ? h(Banner, null, result.brief) : null,
          result.skill ? h('div', { className: 'eng-card', style: { padding: 16, marginBottom: 12 } },
            h('div', { className: 'eng-actions', style: { marginBottom: 8 } }, h(Badge, { tone: 'brand' }, '高确定技能'), h('span', { className: 'eng-mono' }, result.skill.id)),
            h('h3', { className: 'eng-detail-title' }, result.skill.name),
            h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, result.skill.description),
            h('pre', { className: 'eng-pre' }, result.skill.body)) : null,
          candidates.length === 0 ? h(Empty, null, result.note || '没有相近候选') : h('div', { className: 'eng-stack' }, candidates.map((item, index) => engineShape
            ? h('div', { key: item.action || index, className: 'eng-card', style: { padding: 14 } },
                h('div', { className: 'eng-actions', style: { marginBottom: 8 } },
                  h('strong', null, item.action || '（无做法）'),
                  h('span', { className: 'eng-mono' }, `Â ${fmtNumber(item.advantage)}`),
                  h('span', { className: 'eng-muted' }, `Q ${fmtNumber(item.Q)} · V ${fmtNumber(item.V)} · support ${item.support || 0}`)),
                h('div', { className: 'eng-stack' }, (item.evidence || []).map((evidence) => {
                  const [label, tone] = outcomeOf(evidence.outcome)
                  return h('div', { key: evidence.id, className: 'eng-row', style: { gridTemplateColumns: '60px 70px minmax(0,1fr) auto', cursor: 'default' } },
                    h(Badge, { tone }, label),
                    h('span', { className: 'eng-mono' }, `G ${fmtNumber(evidence.G)}`),
                    h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-sub' }, `${evidence.id} · sim ${fmtNumber(evidence.similarity)}`), evidence.note ? h('div', { className: 'eng-row-sub' }, evidence.note) : null),
                    h('div', { className: 'eng-actions' },
                      h(Button, { small: true, onClick: () => feedback(evidence.id, 'helped') }, '有帮助'),
                      h(Button, { small: true, onClick: () => feedback(evidence.id, 'hurt') }, '没帮上')))
                })))
            : h('div', { key: item.id, className: 'eng-card', style: { padding: 14 } },
                h('div', { className: 'eng-actions', style: { marginBottom: 6 } }, h(Badge, { tone: outcomeOf(item.outcome)[1] }, outcomeOf(item.outcome)[0]), h('span', { className: 'eng-mono' }, `G ${fmtNumber(item.G)}`)),
                h('div', { className: 'eng-row-intent' }, item.intent || '（无意图）'),
                h('div', { className: 'eng-muted', style: { marginTop: 4 } }, item.action || '—')))))))
    }

    function Record() {
      const [form, setForm] = useState({ intent: '', action: '', outcome: 'success', type: '', context: '', note: '', taskId: '', kind: 'task', stepIndex: '', stepTotal: '', expectedG: '', expectedOutcome: '', skillId: '', blockedBy: '' })
      const [receipt, setReceipt] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const update = (key) => (event) => setForm({ ...form, [key]: event.target.value })
      const submit = async () => {
        setBusy(true); setError(''); setReceipt(null)
        try {
          const body = {
            intent: form.intent, action: form.action, outcome: form.outcome, type: form.type,
            context: form.context.trim() === '' ? [] : form.context.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
            note: form.note,
          }
          if (form.taskId.trim() !== '') body.taskId = form.taskId.trim()
          if (form.kind === 'step') {
            body.kind = 'step'
            if (form.stepIndex !== '') body.stepIndex = Number(form.stepIndex)
            if (form.stepTotal !== '') body.stepTotal = Number(form.stepTotal)
          }
          if (form.expectedG !== '') body.expectedG = Number(form.expectedG)
          if (form.expectedOutcome !== '') body.expectedOutcome = form.expectedOutcome
          if (form.skillId.trim() !== '') body.skillId = form.skillId.trim()
          if (form.blockedBy.trim() !== '') body.blockedBy = form.blockedBy.trim()
          setReceipt(await request('/record', { method: 'POST', body }))
        } catch (caught) {
          setError(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'eng-fill' },
        h('div', { className: 'eng-card eng-scroll', style: { padding: 18 } },
        error ? h(Banner, { bad: true }, error) : null,
        receipt ? h(Banner, null, `已记录：action=${receipt.action}，id=${receipt.id}，G=${fmtNumber(receipt.G)}${receipt.skillWarning ? `；${receipt.skillWarning}` : ''}`) : null,
        h('div', { className: 'eng-form-grid' },
          h(Field, { label: '意图（做什么）', wide: true }, h('input', { className: 'eng-input', value: form.intent, onChange: update('intent'), placeholder: '例如：给研学课 PPT 插一页过渡页' })),
          h(Field, { label: '做法', wide: true }, h('input', { className: 'eng-input', value: form.action, onChange: update('action'), placeholder: '可复用的具体做法' })),
          h(Field, { label: '结果' }, h('select', { className: 'eng-select', value: form.outcome, onChange: update('outcome') }, Object.keys(OUTCOMES).map((key) => h('option', { key, value: key }, OUTCOMES[key][0])))),
          h(Field, { label: '类型' }, h('input', { className: 'eng-input', value: form.type, onChange: update('type'), placeholder: 'PPT / 课件' })),
          h(Field, { label: '情境（逗号分隔）' }, h('input', { className: 'eng-input', value: form.context, onChange: update('context'), placeholder: 'windows, powerpoint' })),
          h(Field, { label: '预期 G（可选）' }, h('input', { className: 'eng-input', type: 'number', step: '0.05', value: form.expectedG, onChange: update('expectedG'), placeholder: '0.8' })),
          h(Field, { label: '预期结果（可选）' }, h('select', { className: 'eng-select', value: form.expectedOutcome, onChange: update('expectedOutcome') }, h('option', { value: '' }, '不设置'), ['accepted','success','partial','unknown','failed','corrected','aborted'].map((key) => h('option', { key, value: key }, OUTCOMES[key] ? OUTCOMES[key][0] : key)))),
          h(Field, { label: '任务 id（可选）' }, h('input', { className: 'eng-input', value: form.taskId, onChange: update('taskId') })),
          h(Field, { label: '粒度' }, h('select', { className: 'eng-select', value: form.kind, onChange: update('kind') }, h('option', { value: 'task' }, '整条任务'), h('option', { value: 'step' }, '任务步骤'))),
          h(Field, { label: '步骤序号（kind=step）' }, h('input', { className: 'eng-input', type: 'number', value: form.stepIndex, onChange: update('stepIndex') })),
          h(Field, { label: '步骤总数（kind=step）' }, h('input', { className: 'eng-input', type: 'number', value: form.stepTotal, onChange: update('stepTotal') })),
          h(Field, { label: '技能 id（可选）' }, h('input', { className: 'eng-input', value: form.skillId, onChange: update('skillId'), placeholder: 'skill:<slug>' })),
          h(Field, { label: '受阻描述（可选）' }, h('input', { className: 'eng-input', value: form.blockedBy, onChange: update('blockedBy'), placeholder: '页脚错位 第 3 行' })),
          h(Field, { label: '备注', wide: true }, h('textarea', { className: 'eng-textarea', value: form.note, onChange: update('note') }))),
        h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy || form.intent.trim() === '' || form.action.trim() === '', onClick: submit }, busy ? '提交中…' : '记录'))))
    }

    /**
     * 技能的分类 + 便签编辑器：一个技能可以挂多个分类、多条便签（技能套件常用）。
     * key 用技能 id，切技能时自然重置草稿。
     */
    function SkillMetaEditor(props) {
      const row = props.row
      const [categories, setCategories] = useState(Array.isArray(row.typeNames) ? row.typeNames.join('、') : '')
      const [notes, setNotes] = useState(Array.isArray(row.notes) ? row.notes.join('\n') : '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const save = async () => {
        setBusy(true)
        setError('')
        try {
          const splitCategories = categories.split(/[,，、\n]/u).map((item) => item.trim()).filter((item) => item !== '')
          const splitNotes = notes.split(/\n/u).map((item) => item.trim()).filter((item) => item !== '')
          const out = await request('/skill-meta', { method: 'POST', body: { slug: row.id, typeNames: splitCategories, notes: splitNotes } })
          await props.onSaved(`已保存：${(out.typeNames || []).length} 个分类、${(out.notes || []).length} 条便签`)
        } catch (caught) {
          setError(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'eng-actions', style: { alignItems: 'flex-start', gap: 8, marginBottom: 10 } },
        h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
          h('div', { className: 'eng-label', style: { marginBottom: 4 } }, '分类（逗号分隔，可多个）'),
          h('input', { className: 'eng-input', value: categories, placeholder: '例如：PPT / 课件、文档 / 教案', onChange: (event) => setCategories(event.target.value) })),
        h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
          h('div', { className: 'eng-label', style: { marginBottom: 4 } }, '便签（每行一条）'),
          h('textarea', { className: 'eng-textarea', rows: 2, value: notes, placeholder: '例如：需要 python-pptx 环境', onChange: (event) => setNotes(event.target.value) })),
        h('div', { style: { flex: '0 0 auto', paddingTop: 20 } },
          h(Button, { small: true, disabled: busy, onClick: save }, busy ? '保存中…' : '保存分类与便签')),
        error ? h('div', { className: 'eng-muted', style: { color: 'var(--eng-bad)', flexBasis: '100%' } }, error) : null)
    }

    function Skills(props) {
      const skills = useLoad(useCallback(() => request('/skills'), []))
      const validation = useLoad(useCallback(() => request('/validate'), []))
      const [selected, setSelected] = useState(null)
      const [intent, setIntent] = useState('')
      const [context, setContext] = useState('')
      const [notice, setNotice] = useState('')
      // 「忘记技能」两步确认：第一下只把按钮换成「确认忘记」，避免误点删掉资产
      const [confirmForget, setConfirmForget] = useState('')
      const rows = skills.data ? skills.data.skills || [] : []
      const current = selected === null ? null : rows.find((row) => row.id === selected) || null
      const act = async (fn) => {
        try {
          setNotice(await fn())
          await Promise.all([skills.reload(), validation.reload()])
          props.onChanged()
        } catch (caught) {
          setNotice(caught.message || String(caught))
        }
      }
      return h('div', { className: 'eng-fill' },
        skills.error ? h(Banner, { bad: true }, skills.error) : null,
        notice ? h(Banner, null, notice) : null,
        h('div', { className: 'eng-split', 'data-open': current === null ? 'false' : 'true' },
          h('div', { className: 'eng-card' },
            rows.length === 0 ? h(Empty, null, '还没有固化技能：至少 3 条同族经验（含正负对照）后沉淀') : rows.map((row) => {
              const [label, tone] = skillStateOf(row.status)
              return h('div', { key: row.id, className: 'eng-skill-row', 'data-on': selected === row.id ? 'true' : 'false', onClick: () => { setSelected(row.id); setConfirmForget('') } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { className: 'eng-skill-name' }, row.name),
                  h('div', { className: 'eng-skill-desc' }, row.description || '—'),
                  h('div', { className: 'eng-actions', style: { marginTop: 6 } },
                    h(Badge, { tone }, label),
                    h('span', { className: 'eng-muted' }, `uses ${row.uses || 0} · helped ${row.helped || 0} · hurt ${row.hurt || 0}`),
                    row.globalRegistered ? h(Badge, { tone: 'brand' }, '全局') : null,
                    row.pendingCommit ? h(Badge, { tone: 'warn' }, '待补提交') : null,
                    h('span', { className: 'eng-muted' }, `文件 ${Array.isArray(row.files) ? row.files.length : 0}`))),
                h('span', { className: 'eng-mono', style: { flex: '0 0 auto' } }, row.id))
            })),
          h('div', { className: 'eng-stack' },
            h('div', { className: 'eng-card', style: { padding: 15 } },
              h('h3', { className: 'eng-section-title', style: { marginBottom: 8 } }, '沉淀技能'),
              h(Field, { label: '同族意图' }, h('input', { className: 'eng-input', value: intent, onChange: (event) => setIntent(event.target.value), placeholder: '例如：给 PPT 插页' })),
              h(Field, { label: '情境（逗号分隔，可选）' }, h('input', { className: 'eng-input', value: context, onChange: (event) => setContext(event.target.value) })),
              h(Button, { kind: 'primary', disabled: intent.trim() === '', onClick: () => act(async () => { const out = await request('/consolidate', { method: 'POST', body: { intent, context: context.trim() === '' ? [] : context.split(/[,，]/).map((item) => item.trim()).filter(Boolean) } }); return `沉淀结果：${out.action}${out.slug ? `（${out.slug}）` : ''}` }) }, '沉淀')),
            h('div', { className: 'eng-card', style: { padding: 15 } },
              h('h3', { className: 'eng-section-title', style: { marginBottom: 8 } }, '技能校验'),
              validation.data && validation.data.problems && validation.data.problems.length > 0
                ? validation.data.problems.map((item) => h('div', { key: item.slug, className: 'eng-muted', style: { marginBottom: 6 } }, `${item.slug}：${item.problems.join('；')}`))
                : h('div', { className: 'eng-muted' }, '全部健康')),
            current === null ? h('div', { className: 'eng-card eng-detail-card' }, h(Empty, null, '选一个技能看正文')) : h('div', { className: 'eng-card eng-detail-card' },
              h('div', { className: 'eng-detail' },
                h('h3', { className: 'eng-detail-title' }, current.name),
                h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, current.description || '—'),
                h(SkillMetaEditor, { key: current.id, row: current, onSaved: async (message) => { await skills.reload(); props.onChanged(); setNotice(message) } }),
                h('div', { className: 'eng-actions', style: { marginBottom: 10 } },
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id, result: 'helped' } }); return '已记「有帮助」' }) }, '有帮助'),
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id, result: 'hurt' } }); return '已记「没帮上」' }) }, '没帮上'),
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id, result: 'neutral' } }); return '已记「中性」' }) }, '中性'),
                  h(Button, {
                    small: true,
                    kind: current.globalRegistered ? undefined : 'primary',
                    title: current.globalRegistered
                      ? '把链接从 DSH skills 目录里删掉，技能回到经验库排序'
                      : '链接进 DSH 的 skills 目录：之后由 DSH 当普通技能加载，经验库不再排序它',
                    onClick: () => act(async () => {
                      const out = await request('/skill-global', { method: 'POST', body: { slug: current.id, action: current.globalRegistered ? 'unregister' : 'register' } })
                      return out.registered
                        ? `已注册到全局：${out.targetDir}`
                        : `已取消注册${out.removed ? '' : '（链接本来就不在了，已清理记录）'}`
                    }),
                  }, current.globalRegistered ? '取消注册' : '注册技能到全局'),
                  h(Button, {
                    small: true,
                    kind: 'danger',
                    title: confirmForget === current.id ? '再点一次就删掉这个技能目录' : '从经验库删除这个技能',
                    onClick: () => {
                      if (confirmForget !== current.id) {
                        setConfirmForget(current.id)
                        return
                      }
                      act(async () => {
                        const out = await request('/skill-forget', { method: 'POST', body: { slug: current.id } })
                        setConfirmForget('')
                        setSelected(null)
                        return `已忘记技能：${out.slug}`
                      })
                    },
                  }, confirmForget === current.id ? '确认忘记' : '忘记技能')),
                h('div', { className: 'eng-muted', style: { marginBottom: 10, fontSize: 12 } }, current.globalRegistered
                  ? `已注册到全局（${current.globalPath || 'DSH skills 目录'}）：DSH 会把它当真实技能加载，经验库不再排序/召回它；点「取消注册」回到经验库管理。`
                  : '还没注册到全局：它归经验库自己管，召回时按需以技能形态交给模型；要当普通技能用就点「注册技能到全局」。'),
                Array.isArray(current.files) && current.files.length > 0
                  ? h('div', { style: { marginBottom: 10 } }, h('div', { className: 'eng-label', style: { marginBottom: 4 } }, '脚本附件'), current.files.map((file) => h('div', { key: file, className: 'eng-mono eng-muted' }, file)))
                  : null,
                h('pre', { className: 'eng-pre' }, current.body || '（空）'))))))
    }

    /**
     * 在拖进来的文件夹里找 SKILL.md（浏览器没有路径能力，只能顺着 FileSystemEntry 往下钻）。
     * 深度限制 4 层，避免用户把整个盘拖进来卡死。
     */
    async function findSkillFileInEntry(entry, depth = 0) {
      if (entry === null || entry === undefined) return null
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)))
        if (!file) return null
        return /^skill\.md$/iu.test(file.name) || /\.md$/iu.test(file.name) ? file : null
      }
      if (!entry.isDirectory || depth >= 4) return null
      const reader = entry.createReader()
      const readBatch = () => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
      let batch = await readBatch()
      while (batch.length > 0) {
        for (const child of batch) {
          const found = await findSkillFileInEntry(child, depth + 1)
          if (found !== null) return found
        }
        batch = await readBatch()
      }
      return null
    }

    /**
     * 「添加技能」：把外部技能拖进来 / 选文件夹 / 选 SKILL.md 导入。
     *
     * 安装位置是固定的（经验库 `.exp/skills/<slug>/`），所以不再让用户填路径——
     * 路径框除了制造「填了也没用」的误会没有别的用。浏览器读不到任意路径，
     * 只能读用户亲手选/拖的文件，因此入口做成拖拽区 + 两个选择器。
     *
     * 分类 / 标签 / 排序由宿主开一个**临时模型会话**算，这会真实产生一次模型调用；
     * 宿主没有模型服务时退回本地关键词归类，界面上必须如实说明是哪一种。
     */
    function ImportSkillDialog(props) {
      const [content, setContent] = useState('')
      const [fileName, setFileName] = useState('')
      const [dragging, setDragging] = useState(false)
      const [showPaste, setShowPaste] = useState(false)
      const [sourcePath, setSourcePath] = useState('')
      const [categoriesDraft, setCategoriesDraft] = useState('')
      const [notesDraft, setNotesDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const fileInputRef = useRef(null)
      const dirInputRef = useRef(null)
      const canSubmit = busy === false && (sourcePath.trim() !== '' || content.trim() !== '')
      const takeFile = async (file) => {
        if (file === null || file === undefined) return
        const name = String(file.name || '')
        if (/\.zip$/iu.test(name)) {
          setError('浏览器里解不开 zip：解压后选「技能文件夹」，或直接选里面的 SKILL.md')
          return
        }
        if (!/\.md$/iu.test(name)) {
          setError(`只认 SKILL.md / .md，收到的是：${name}`)
          return
        }
        try {
          const text = await file.text()
          if (String(text || '').trim() === '') {
            setError('这个文件是空的')
            return
          }
          setContent(text)
          setFileName(name)
          setSourcePath('')
          setError('')
        } catch (caught) {
          setError(`读取失败：${caught && caught.message ? caught.message : String(caught)}`)
        }
      }
      const onDrop = async (event) => {
        event.preventDefault()
        setDragging(false)
        const items = (event.dataTransfer && event.dataTransfer.items) || []
        const files = []
        for (const item of items) {
          if (item === null || item.kind !== 'file') continue
          const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
          if (entry !== null && entry !== undefined && entry.isDirectory) {
            const found = await findSkillFileInEntry(entry)
            if (found !== null) {
              await takeFile(found)
              return
            }
            continue
          }
          const file = item.getAsFile()
          if (file !== null) files.push(file)
        }
        const picked = files.find((file) => /^skill\.md$/iu.test(file.name)) || files.find((file) => /\.md$/iu.test(file.name)) || files[0]
        if (picked === undefined) setError('没找到 SKILL.md：把技能文件夹或 SKILL.md 拖进来')
        else await takeFile(picked)
      }
      const onPicked = async (event) => {
        const list = Array.from((event.target && event.target.files) || [])
        // 选的是整个文件夹时，文件列表里第一个不一定是 SKILL.md，先挑它
        const picked = list.find((file) => /^skill\.md$/iu.test(file.name)) || list.find((file) => /\.md$/iu.test(file.name)) || list[0]
        if (picked !== undefined) await takeFile(picked)
        if (event.target) event.target.value = ''
      }
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const splitList = (text) => String(text || '').split(/[,，\n]/u).map((item) => item.trim()).filter((item) => item !== '')
          const body = sourcePath.trim() !== '' ? { path: sourcePath.trim() } : { content }
          body.categories = splitList(categoriesDraft)
          body.notes = splitList(notesDraft)
          const out = await request('/skills/import', { method: 'POST', body })
          setResult(out)
          props.onImported(out)
        } catch (caught) {
          setError(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'eng-modal-mask', role: 'dialog', 'aria-modal': 'true', 'aria-label': '添加技能' },
        h('div', { className: 'eng-modal' },
          h('h3', { className: 'eng-modal-title' }, '添加技能'),
          h('div', { className: 'eng-dropzone', 'data-dragging': dragging ? 'true' : 'false', role: 'button', tabIndex: 0, title: '拖入技能文件夹或 SKILL.md', onClick: () => { if (fileInputRef.current) fileInputRef.current.click() }, onDragOver: (event) => { event.preventDefault(); setDragging(true) }, onDragLeave: () => setDragging(false), onDrop: onDrop },
            h('div', { className: 'eng-dropzone-title' }, '拖拽技能到此处'),
            h('div', { className: 'eng-dropzone-sub' }, '支持技能文件夹或单个 SKILL.md'),
            h('div', { className: 'eng-dropzone-actions' },
              h('button', { type: 'button', className: 'eng-dropzone-link', onClick: (event) => { event.stopPropagation(); if (dirInputRef.current) dirInputRef.current.click() } }, '选择文件夹'),
              h('span', { className: 'eng-muted' }, '/'),
              h('button', { type: 'button', className: 'eng-dropzone-link', onClick: (event) => { event.stopPropagation(); if (fileInputRef.current) fileInputRef.current.click() } }, '选择文件')),
            fileName === '' ? null : h('div', { className: 'eng-dropzone-file' }, `已选择：${fileName}（${content.length} 字）`)),
          h('input', { ref: fileInputRef, type: 'file', accept: '.md,.markdown,text/markdown', style: { display: 'none' }, onChange: onPicked }),
          h('input', { ref: dirInputRef, type: 'file', webkitdirectory: '', directory: '', multiple: true, style: { display: 'none' }, onChange: onPicked }),
          h('div', { className: 'eng-fixed-target' },
            h('span', { className: 'eng-muted' }, '安装位置'),
            h('code', { className: 'eng-mono', style: { fontSize: 12 } }, '经验库 .exp/skills/<slug>/（固定，不用填）')),
          h('div', { className: 'eng-fixed-target', style: { marginTop: 10 } },
            h('span', { className: 'eng-muted' }, '来源路径'),
            h('input', { className: 'eng-input', style: { flex: '1 1 240px' }, value: sourcePath, placeholder: 'C:\\Users\\you\\my-skill（技能文件夹或 SKILL.md）', onChange: (event) => setSourcePath(event.target.value) })),
          h('div', { className: 'eng-muted', style: { marginTop: 4, fontSize: 12 } }, '拖拽被宿主窗口拦掉时用这个：粘绝对路径由服务端直接读（文件夹或 SKILL.md；zip 请先解压）。'),
          h('div', { className: 'eng-fixed-target', style: { marginTop: 10 } },
            h('span', { className: 'eng-muted' }, '分类'),
            h('input', { className: 'eng-input', style: { flex: '1 1 240px' }, value: categoriesDraft, placeholder: '逗号分隔，可多个（技能套件常用）', onChange: (event) => setCategoriesDraft(event.target.value) })),
          h('div', { className: 'eng-fixed-target', style: { marginTop: 8 } },
            h('span', { className: 'eng-muted' }, '便签'),
            h('input', { className: 'eng-input', style: { flex: '1 1 240px' }, value: notesDraft, placeholder: '逗号分隔，可多条（给人看的备注）', onChange: (event) => setNotesDraft(event.target.value) })),
          h('div', { className: 'eng-muted', style: { marginTop: 4, fontSize: 12 } }, '分类与便签会写到每条导入的技能上，之后还能在技能详情里改。'),
          h('ul', { className: 'eng-req' },
            h('li', null, '技能文件夹需包含 SKILL.md'),
            h('li', null, '套件文件夹：子目录各带 SKILL.md 时按套件逐个导入（需用「来源路径」）'),
            h('li', null, 'SKILL.md 需带 YAML 的 name 与 description'),
            h('li', null, '导入只复制正文；scripts/ 等附件可在导入后用 exp_skill_attach 挂上')),
          showPaste
            ? h('textarea', { className: 'eng-textarea', rows: 8, style: { marginTop: 10 }, value: content, onChange: (event) => { setContent(event.target.value); setFileName('') }, placeholder: '--- name: 我的技能 description: 一句话说明 --- 再接正文' })
            : h('button', { type: 'button', className: 'eng-dropzone-link', style: { marginTop: 8, fontSize: 12 }, onClick: () => setShowPaste(true) }, '没有文件？直接粘贴 SKILL.md 正文'),
          h('div', { className: 'eng-modal-warn' },
            h('div', null, h('b', null, '会产生额外消耗：'), '导入时会开一个临时模型会话读一遍正文，算出分类、标签、排序分——这是一次真实的模型调用（按当前模型计费）。'),
            h('div', { style: { marginTop: 4 } }, '宿主没有可用的模型服务时会退回本地关键词归类，那种情况不消耗模型，结果里会标明「本地」。')),
          error ? h(Banner, { bad: true }, error) : null,
          result
            ? h('div', { className: 'eng-card', style: { padding: 12, marginTop: 12 } },
              h('div', { style: { fontWeight: 620, marginBottom: 6 } }, result.suite ? `已导入技能套件：${result.count} 个技能` : `已导入：${(result.items && result.items[0] ? result.items[0].name : result.name)}（${(result.items && result.items[0] ? result.items[0].action : result.action)}）`),
              (result.items || [result]).map((item) => h('div', { key: item.slug || item.name, className: 'eng-muted', style: { lineHeight: 1.8 } },
                `· ${item.name}（${item.slug}）分类：${item.category || '未分类'}${item.classifier === 'local' ? '（本地归类）' : ''}`)),
              h('div', { className: 'eng-muted', style: { marginTop: 6 } }, '导入的内容已在技能列表里，弹窗不会自动关，方便你核对；关掉后列表自动刷新。'))
            : null,
          h('div', { className: 'eng-modal-actions' },
            h(Button, { small: true, onClick: props.onClose }, result ? '关闭' : '取消'),
            h(Button, { small: true, kind: 'primary', disabled: !canSubmit, onClick: submit }, busy ? '安装中…（会调一次模型，套件按个数累加）' : '安装'))))
    }

    function Types(props) {
      const types = useLoad(useCallback(() => request('/types'), []))
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [notice, setNotice] = useState('')
      const [selected, setSelected] = useState('')
      const [newName, setNewName] = useState('')
      const [mergeInto, setMergeInto] = useState('')
      const rows = types.data ? types.data.types || [] : []
      const current = rows.find((row) => row.id === selected) || null
      const op = async (body) => {
        try {
          const out = await request('/type', { method: 'POST', body })
          setNotice(`已执行：${out.action || '类型操作'}`)
          await types.reload()
          props.onChanged()
        } catch (caught) {
          setNotice(caught.message || String(caught))
        }
      }
      return h('div', { className: 'eng-fill' },
        types.error ? h(Banner, { bad: true }, types.error) : null,
        notice ? h(Banner, null, notice) : null,
        h('div', { className: 'eng-card', style: { padding: 15, marginBottom: 14 } },
          h('div', { className: 'eng-form-grid' },
            h(Field, { label: '新类型名称' }, h('input', { className: 'eng-input', value: name, onChange: (event) => setName(event.target.value) })),
            h(Field, { label: '描述（可选）' }, h('input', { className: 'eng-input', value: description, onChange: (event) => setDescription(event.target.value) }))),
          h(Button, { kind: 'primary', disabled: name.trim() === '', onClick: () => op({ action: 'create', name: name.trim(), description: description.trim() }) }, '新建类型')),
        h('div', { className: 'eng-card eng-scroll' },
          h('table', { className: 'eng-table' },
            h('thead', null, h('tr', null, h('th', null, '名称'), h('th', null, 'id'), h('th', null, '条数'), h('th', null, '类型'))),
            h('tbody', null, rows.map((row) => h('tr', { key: row.id, style: { cursor: row.system ? 'default' : 'pointer' }, onClick: () => { if (!row.system) { setSelected(row.id); setNewName(row.name); setMergeInto('') } } },
              h('td', null, row.name),
              h('td', { className: 'eng-mono' }, row.id),
              h('td', null, String(row.count || 0)),
              h('td', null, row.system ? h('span', { className: 'eng-muted' }, '系统') : (selected === row.id ? h(Badge, { tone: 'brand' }, '管理中') : h('span', { className: 'eng-muted' }, '点击管理')))))))),
        current === null ? null : h('div', { className: 'eng-card eng-detail', style: { marginTop: 14 } },
          h('h3', { className: 'eng-detail-title' }, `管理：${current.name}`),
          h('div', { className: 'eng-form-grid' },
            h(Field, { label: '新名称' }, h('input', { className: 'eng-input', value: newName, onChange: (event) => setNewName(event.target.value) })),
            h(Field, { label: '合并到' }, h('select', { className: 'eng-select', value: mergeInto, onChange: (event) => setMergeInto(event.target.value) },
              h('option', { value: '' }, '选择目标类型'),
              rows.filter((row) => row.id !== current.id && !row.system).map((row) => h('option', { key: row.id, value: row.name }, row.name))))),
          h('div', { className: 'eng-actions' },
            h(Button, { small: true, disabled: newName.trim() === '', onClick: () => op({ action: 'rename', name: current.name, newName: newName.trim() }) }, '改名'),
            h(Button, { small: true, disabled: mergeInto === '', onClick: () => op({ action: 'merge', names: [current.name, mergeInto], newName: mergeInto }) }, '合并'),
            h(Button, { small: true, kind: 'danger', onClick: () => op({ action: 'delete', name: current.name }) }, '删除'))))
    }

    function Usage() {
      const usage = useLoad(useCallback(() => request('/usage?limit=200'), []))
      const rows = usage.data ? usage.data.rows || [] : []
      return h('div', { className: 'eng-fill' },
        usage.error ? h(Banner, { bad: true }, usage.error) : null,
        h('div', { className: 'eng-card eng-scroll' }, rows.length === 0 ? h(Empty, null, usage.loading ? '读取中…' : '还没有调用记录') : h('table', { className: 'eng-table' },
          h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '工具'), h('th', null, '意图'), h('th', null, '结果'))),
          h('tbody', null, rows.map((row, index) => h('tr', { key: index },
            h('td', { className: 'eng-mono' }, fmtTime(row.at)),
            h('td', null, row.tool || '—'),
            h('td', null, row.intent || row.action || '—'),
            h('td', null, row.feedback || (row.ok === false ? '失败' : 'ok'))))))))
    }

    const GRAPH_THEMES = ['personal', 'dream', 'knowledge', 'emotion', 'spacetime', 'collective', 'inspiration']
    function lightenColor(color, amount = 0.55) {
      const text = String(color || '').trim()
      let r = 0
      let g = 0
      let b = 0
      let a = 1
      const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
      const rgb = text.match(/^rgba?\(([^)]+)\)$/i)
      if (hex) {
        const value = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1]
        r = parseInt(value.slice(0, 2), 16)
        g = parseInt(value.slice(2, 4), 16)
        b = parseInt(value.slice(4, 6), 16)
      } else if (rgb) {
        const parts = rgb[1].split(/[\s,\/]+/).filter(Boolean)
        r = Number(parts[0]) || 0
        g = Number(parts[1]) || 0
        b = Number(parts[2]) || 0
        a = parts[3] === undefined ? 1 : Number(parts[3])
      } else {
        return color
      }
      const mix = (channel) => Math.round(channel + (255 - channel) * amount)
      return `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${a})`
    }

    /** 给任意颜色套一个 alpha（hex / rgb / rgba 都吃），用于「中心亮 → 边缘透明」的发光渐变。 */
    function withAlpha(color, alpha) {
      const text = String(color || '').trim()
      const value = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1))
      const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)
      if (hex) {
        const full = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1]
        return `rgba(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)}, ${value})`
      }
      const rgb = text.match(/^rgba?\(([^)]+)\)$/iu)
      if (rgb) {
        const parts = rgb[1].split(/[\s,\/]+/u).filter(Boolean)
        return `rgba(${Math.round(Number(parts[0]) || 0)}, ${Math.round(Number(parts[1]) || 0)}, ${Math.round(Number(parts[2]) || 0)}, ${value})`
      }
      return `rgba(128, 128, 128, ${value})`
    }

    /** 颜色 → {r,g,b}（hex / rgb / rgba）；解析不了返回 null。 */
    function parseRgbColor(color) {
      const text = String(color || '').trim()
      const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)
      if (hex) {
        const full = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1]
        return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
      }
      const rgb = text.match(/^rgba?\(([^)]+)\)$/iu)
      if (rgb) {
        const parts = rgb[1].split(/[\s,\/]+/u).filter(Boolean)
        return { r: Math.round(Number(parts[0]) || 0), g: Math.round(Number(parts[1]) || 0), b: Math.round(Number(parts[2]) || 0) }
      }
      return null
    }

    function rgbToHsl(rgb) {
      const r = rgb.r / 255
      const g = rgb.g / 255
      const b = rgb.b / 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const l = (max + min) / 2
      if (max === min) return { h: 0, s: 0, l }
      const delta = max - min
      const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
      let h
      if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6
      else if (max === g) h = ((b - r) / delta + 2) / 6
      else h = ((r - g) / delta + 4) / 6
      return { h, s, l }
    }

    function hslToHex(h, s, l) {
      const hue = ((h % 1) + 1) % 1
      const channel = (p, q, t) => {
        let value = t
        if (value < 0) value += 1
        if (value > 1) value -= 1
        if (value < 1 / 6) return p + (q - p) * 6 * value
        if (value < 1 / 2) return q
        if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
        return p
      }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s
      const p = 2 * l - q
      const r = Math.round(channel(p, q, hue + 1 / 3) * 255)
      const g = Math.round(channel(p, q, hue) * 255)
      const b = Math.round(channel(p, q, hue - 1 / 3) * 255)
      return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
    }

    /** 颜色饱和度（0~1）；读不到颜色按 0 处理。 */
    function colorSaturation(color) {
      const rgb = parseRgbColor(color)
      if (rgb === null) return 0
      return rgbToHsl(rgb).s
    }

    /**
     * 把主题里的颜色变成能画的节点色：保色相，把饱和度提上来、亮度压进可读区间。
     * 主题背景渐变多是接近纯白的粉/薰衣草（#fff8fc 这种），直接压暗就变灰——
     * 之前「切到跟随主题后整张图发灰」就是这一步只做了明暗、没补饱和度。
     */
    function vividColor(color, dark) {
      const rgb = parseRgbColor(color) || { r: 128, g: 128, b: 128 }
      const hsl = rgbToHsl(rgb)
      // 保色相；饱和度抬到能分辨的下限、但不拉到荧光（昔涟这种柔和主题要留点灰调）
      const saturation = dark
        ? Math.min(0.86, Math.max(hsl.s, 0.58))
        : Math.min(0.8, Math.max(hsl.s, 0.55))
      const lightness = dark
        ? Math.min(0.74, Math.max(hsl.l, 0.62))
        : Math.min(0.62, Math.max(hsl.l, 0.5))
      return hslToHex(hsl.h, saturation, lightness)
    }

    // 「蓝紫星辰」= dsh-codex-effort-slider 那条推理能量滑条的渐变：
    // #4d93f8 蓝 → #6d28d9 深紫 → #9333ea 紫 → #c084fc 淡紫（滑条实色为 #3b1178→#c084fc，
    // 两端取更亮的一档，保证图上节点在浅色/深色主题都看得清）。
    const CODEX_STAR_STOPS = [
      { node: '#6d28d9', nodeLight: '#a78bfa', node2: '#4d93f8', edge: '#7c3aed', highlight: '#c084fc', glow: '#9333ea', dust: '#c4b5fd' },
      { node: '#4d93f8', nodeLight: '#93c5fd', node2: '#9333ea', edge: '#6d28d9', highlight: '#c084fc', glow: '#6d28d9', dust: '#bfdbfe' },
    ]

    const GRAPH_PALETTES = {
      dsh: {},
      codex: { bg: '#050418', bgInner: '#0d0b26', node: CODEX_STAR_STOPS[0].node, node2: CODEX_STAR_STOPS[0].node2, edge: CODEX_STAR_STOPS[0].edge, highlight: CODEX_STAR_STOPS[0].highlight, warn: '#c084fc', ok: '#7aaaff', bad: '#f472b6', glow: CODEX_STAR_STOPS[0].glow, dust: CODEX_STAR_STOPS[0].dust, bloom: 20 },
      cyberpunk: { bg: '#020308', bgInner: '#071023', node: '#00f0ff', node2: '#ff2bd6', edge: '#7b2cff', highlight: '#ff2bd6', warn: '#ffd166', ok: '#39ff88', bad: '#ff3b5c', glow: '#ff2bd6', dust: '#8fe9ff', bloom: 22 },
      aurora: { bg: '#010208', bgInner: '#06101a', node: '#7dffd4', node2: '#b892ff', edge: '#7cc7ff', highlight: '#c9b6ff', warn: '#ffe3a3', glow: '#9dffdf', dust: '#bfffe9', bloom: 18 },
      blackgold: { bg: '#060504', bgInner: '#141006', node: '#ffcc66', node2: '#ff9f2e', edge: '#b9852f', highlight: '#ffe3a3', warn: '#ffcf7a', glow: '#ffb84d', dust: '#ffe3a3', bloom: 16 },
      steampunk: { bg: '#0a0604', bgInner: '#1a0f08', node: '#d9a441', node2: '#b85c2a', edge: '#8a4b22', highlight: '#ffb35c', warn: '#e8c07a', glow: '#ffb35c', dust: '#e0b07a', bloom: 14 },
      qingmo: { bg: '#060909', bgInner: '#0c1614', node: '#8fd6c9', node2: '#c85a4a', edge: '#5f9e93', highlight: '#c85a4a', warn: '#d9c7a7', glow: '#a7e8dd', dust: '#cfe8e0', bloom: 12 },
      minimal: { bg: '#020305', bgInner: '#0a1017', node: '#bfe9ff', node2: '#9fb3c8', edge: '#5c7c99', highlight: '#dff4ff', warn: '#d5dee8', glow: '#a8d8ff', dust: '#9fb3c8', bloom: 6 },
      lava: { bg: '#080302', bgInner: '#1c0805', node: '#ff7a18', node2: '#ff2d2d', edge: '#8a2b12', highlight: '#ffc27a', warn: '#ffb347', glow: '#ff9a3c', dust: '#ffc27a', bloom: 24, ringFill: 'rgba(8,3,2,.55)' },
    }

    /**
     * 十字星芒：给大一点的节点加两长两短的细光线，读起来才像「恒星」而不是一团晕。
     * 线宽和透明度都随半径走，缩远了自动看不见，不会糊成一片。
     */
    function drawStarFlare(ctx, length, color, alpha) {
      if (!(length > 2.4)) return
      ctx.save()
      ctx.strokeStyle = withAlpha(color, alpha)
      ctx.lineCap = 'round'
      ctx.lineWidth = Math.max(0.5, Math.min(1.4, length * 0.045))
      ctx.beginPath()
      ctx.moveTo(-length, 0)
      ctx.lineTo(length, 0)
      ctx.moveTo(0, -length)
      ctx.lineTo(0, length)
      ctx.stroke()
      ctx.globalAlpha *= 0.6
      ctx.lineWidth = Math.max(0.4, Math.min(1, length * 0.03))
      const diagonal = length * 0.62
      ctx.beginPath()
      ctx.moveTo(-diagonal * 0.7, -diagonal * 0.7)
      ctx.lineTo(diagonal * 0.7, diagonal * 0.7)
      ctx.moveTo(diagonal * 0.7, -diagonal * 0.7)
      ctx.lineTo(-diagonal * 0.7, diagonal * 0.7)
      ctx.stroke()
      ctx.restore()
    }

    function drawGraphShape(ctx, radius, theme) {
      if (radius <= 0.2) return
      ctx.beginPath()
      if (theme === 'knowledge') {
        for (let i = 0; i < 6; i += 1) {
          const angle = (Math.PI / 3) * i - Math.PI / 6
          const x = Math.cos(angle) * radius
          const y = Math.sin(angle) * radius
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        return
      }
      if (theme === 'dream') {
        ctx.ellipse(0, 0, radius * 1.35, radius * 0.72, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        return
      }
      if (theme === 'inspiration') {
        for (let i = 0; i < 8; i += 1) {
          const angle = (Math.PI / 4) * i
          const length = i % 2 === 0 ? radius * 1.7 : radius * 0.62
          const x = Math.cos(angle) * length
          const y = Math.sin(angle) * length
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        return
      }
      if (theme === 'spacetime') {
        ctx.arc(0, 0, radius, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(0, -radius * 1.9)
        ctx.lineTo(0, radius * 1.9)
        ctx.strokeStyle = 'rgba(255,255,255,.22)'
        ctx.stroke()
        return
      }
      ctx.arc(0, 0, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      if (theme === 'collective') {
        ctx.beginPath()
        ctx.arc(0, 0, radius * 1.7, 0, Math.PI * 2)
        ctx.stroke()
      } else if (theme === 'emotion') {
        ctx.beginPath()
        ctx.arc(radius * 1.35, -radius * 0.6, radius * 0.28, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    /**
     * 从 `linear-gradient(...)` / `radial-gradient(...)` 字符串里取颜色停靠点。
     * 丢掉透明与接近透明的停靠点；返回 rgba 字符串数组。
     */
    /**
     * 从 background-image 里抽颜色停靠点。
     * 主题背景常是多层（几层 radial 光斑 + 最后一层 linear 底色），radial 里的光斑色不是主色，
     * 所以能切出 linear-gradient 那一段就只认那一段。
     */
    /** 从一段 background-image 里收颜色（去重、丢掉全透明的）。 */
    function collectGradientColors(text) {
      const colors = []
      const pattern = /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:transparent|white|black)\b)/giu
      for (const match of String(text || '').matchAll(pattern)) {
        const raw = String(match[0]).trim().toLowerCase()
        if (raw === 'transparent' || raw === '') continue
        if (raw === 'white' || raw === 'black') {
          colors.push(raw)
          continue
        }
        if (raw.startsWith('#') && raw.length > 7) continue
        const rgba = raw.match(/^rgba?\(([^)]+)\)$/u)
        if (rgba) {
          const parts = rgba[1].split(/[\s,\/]+/u).filter(Boolean)
          const alpha = parts[3] === undefined ? 1 : Number(parts[3])
          if (Number.isFinite(alpha) && alpha <= 0.05) continue
        }
        colors.push(raw)
      }
      const unique = []
      for (const color of colors) {
        const key = color.replace(/\s+/gu, '')
        if (!unique.some((item) => item.replace(/\s+/gu, '') === key)) unique.push(color)
      }
      return unique
    }

    function parseGradientStops(value) {
      const full = String(value || '')
      if (!/gradient\(/iu.test(full)) return []
      return collectGradientColors(sliceLinearGradient(full) || full).slice(0, 6)
    }

    /** 整段 background-image 的所有颜色（含 radial 光斑那一层）。 */
    function parseAllGradientStops(value) {
      const full = String(value || '')
      if (!/gradient\(/iu.test(full)) return []
      return collectGradientColors(full).slice(0, 8)
    }

    /** 取 background-image 里 linear-gradient(...) 那一段（含括号配平）；没有就返回空串。 */
    function sliceLinearGradient(value) {
      const text = String(value || '')
      const at = text.indexOf('linear-gradient(')
      if (at === -1) return ''
      let depth = 0
      for (let index = at + 'linear-gradient'.length; index < text.length; index += 1) {
        const ch = text[index]
        if (ch === '(') depth += 1
        else if (ch === ')') {
          depth -= 1
          if (depth === 0) return text.slice(at, index + 1)
        }
      }
      return text.slice(at)
    }

    /** 颜色亮度（0~1）；解析失败按 0.5 处理。 */
    function colorLuminance(color) {
      const text = String(color || '').trim()
      const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)
      if (hex) {
        const value = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1]
        const r = parseInt(value.slice(0, 2), 16)
        const g = parseInt(value.slice(2, 4), 16)
        const b = parseInt(value.slice(4, 6), 16)
        return (r * 0.299 + g * 0.587 + b * 0.114) / 255
      }
      const rgb = text.match(/^rgba?\(([^)]+)\)$/iu)
      if (rgb) {
        const parts = rgb[1].split(/[\s,\/]+/u).filter(Boolean)
        return ((Number(parts[0]) || 0) * 0.299 + (Number(parts[1]) || 0) * 0.587 + (Number(parts[2]) || 0) * 0.114) / 255
      }
      return 0.5
    }

    /** 往黑色方向压暗；主题渐变的浅色停靠点在浅色背景上会看不见。 */
    function shadeColor(color, amount = 0.35) {
      const text = String(color || '').trim()
      let r = 0
      let g = 0
      let b = 0
      let a = 1
      const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)
      const rgb = text.match(/^rgba?\(([^)]+)\)$/iu)
      if (hex) {
        const value = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1]
        r = parseInt(value.slice(0, 2), 16)
        g = parseInt(value.slice(2, 4), 16)
        b = parseInt(value.slice(4, 6), 16)
      } else if (rgb) {
        const parts = rgb[1].split(/[\s,\/]+/u).filter(Boolean)
        r = Number(parts[0]) || 0
        g = Number(parts[1]) || 0
        b = Number(parts[2]) || 0
        a = parts[3] === undefined ? 1 : Number(parts[3])
      } else if (text === 'white') {
        r = 255; g = 255; b = 255
      } else if (text === 'black') {
        r = 0; g = 0; b = 0
      } else {
        return color
      }
      const mix = (channel) => Math.round(channel * (1 - amount))
      return `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${a})`
    }

    /**
     * 把渐变停靠点压进「画在画布上能看见」的亮度区间。
     * 昔涟这种主题的底色停靠点接近纯白（#fff8fc…），直接拿来画就白茫茫一片，
     * 之前看着"没变化"就是这个原因；这里按明暗主题反复往可读区间推。
     */
    function graphStops(stops, dark) {
      // 走 vividColor：保色相 + 提饱和度 + 亮度进可读区间。
      // 只压明暗不补饱和度会把「接近纯白的主题粉」压成灰（分不清是灰还是没生效）。
      return stops.map((color) => vividColor(color, dark))
    }

    /**
     * 读当前主题的背景渐变。
     * 主题常把渐变画在 `body::before` / `html::after` 这类伪元素上（昔涟就是 body::before），
     * getComputedStyle(body).backgroundImage 读不到，所以伪元素也要探。
     */
    function readThemeGradientStops() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return []
      const candidates = []
      const probe = (element, pseudo) => {
        if (element === null || element === undefined) return
        try {
          const style = getComputedStyle(element, pseudo)
          if (style !== null && style !== undefined) candidates.push(style.backgroundImage)
        } catch {
          // 某些环境不支持伪元素查询：跳过
        }
      }
      try {
        probe(document.body, null)
        probe(document.body, '::before')
        probe(document.body, '::after')
        probe(document.documentElement, null)
        probe(document.documentElement, '::before')
        probe(document.querySelector('.dsh-app'), null)
        probe(document.querySelector('.dsh-app'), '::before')
      } catch {
        return []
      }
      for (const value of candidates) {
        // 先看整段背景里「有颜色」的那几个停靠点——radial 光斑才是主题真正的粉/紫/蓝，
        // linear 底色往往接近纯白（压暗之后就成灰了）。
        const vivid = parseAllGradientStops(value).filter((color) => colorSaturation(color) >= 0.2)
        if (vivid.length >= 2) return vivid.slice(0, 4)
        const stops = parseGradientStops(value)
        if (stops.length >= 2) return stops
      }
      return []
    }

    function readDshGraphPalette(canvas) {
      const local = getComputedStyle(canvas)
      const root = getComputedStyle(document.documentElement)
      const read = (name, fallback) => (local.getPropertyValue(name) || root.getPropertyValue(name) || '').trim() || fallback
      const bg = read('--dsw-alias-bg-layer-1', '#ffffff')
      const bgInner = read('--dsw-alias-bg-layer-2', bg)
      const rgb = bg.match(/\d+(\.\d+)?/g) || ['255', '255', '255']
      const luminance = (Number(rgb[0]) * 0.299 + Number(rgb[1]) * 0.587 + Number(rgb[2]) * 0.114) / 255
      const dark = luminance < 0.45
      // 主题自带渐变（昔涟那种）时沿用它；主题没有渐变就退到「蓝紫星辰」，
      // 不再用 DSH 的默认品牌蓝——那是宿主默认色，跟主题没关系。
      const themeStops = graphStops(readThemeGradientStops(), dark)
      const hasThemeGradient = themeStops.length >= 2
      const star = CODEX_STAR_STOPS[dark ? 1 : 0]
      const pick = (index, fallback) => (hasThemeGradient ? (themeStops[index] || themeStops[themeStops.length - 1]) : fallback)
      return {
        bg: bgInner,
        bgInner: bg,
        node: pick(0, star.node),
        nodeLight: hasThemeGradient ? lightenColor(pick(1, star.nodeLight), 0.3) : star.nodeLight,
        node2: pick(themeStops.length - 1, star.node2),
        edge: pick(1, star.edge),
        highlight: hasThemeGradient ? lightenColor(pick(1, star.highlight), 0.25) : star.highlight,
        glow: pick(0, star.glow),
        dust: hasThemeGradient ? lightenColor(pick(1, star.dust), 0.2) : star.dust,
        ringFill: dark ? 'rgba(8, 12, 20, .55)' : 'rgba(255, 255, 255, .62)',
        dark,
        bloom: dark ? 12 : 7,
      }
    }

    function Graph() {
      const graph = useLoad(useCallback(() => request('/graph'), []))
      const settings = useLoad(useCallback(() => request('/settings'), []))
      const canvasRef = useRef(null)
      const [selection, setSelection] = useState(null)
      const stateRef = useRef({
        nodes: new Map(), edges: new Map(), dust: [],
        cam: { yaw: -0.42, pitch: -0.24, dist: 1420 },
        selected: null, hovered: null, pulse: 0, t: 0, dragging: null, dragMoved: false, userZoom: false,
      })
      // 图上那个胶囊：手动切「跟随主题 / 蓝紫星辰」，写进 ui.graphPalette。
      const graphUi = (settings.data && settings.data.ui) || {}
      const paletteNow = GRAPH_PALETTES[graphUi.graphPalette] ? graphUi.graphPalette : 'dsh'
      const pickPalette = async (key) => {
        if (key === paletteNow) return
        try {
          await request('/settings', { method: 'POST', body: { ui: { graphPalette: key } } })
          await settings.reload()
        } catch (caught) {
          console.error('[engram] graph palette save failed', caught)
        }
      }
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !graph.data) return undefined
        const ui = (settings.data && settings.data.ui) || {}
        const theme = GRAPH_THEMES.includes(ui.graphTheme) ? ui.graphTheme : 'personal'
        const paletteKey = GRAPH_PALETTES[ui.graphPalette] ? ui.graphPalette : 'dsh'
        let palette = paletteKey === 'dsh'
          ? readDshGraphPalette(canvas)
          : (() => {
              const base = GRAPH_PALETTES[paletteKey]
              // 保留调色板自己的第二色/高亮色，别再压成单色（否则自选配色也没有渐变层次）
              return { ...base, nodeLight: lightenColor(base.node, 0.5) }
            })()
        const rotation = Number.isFinite(Number(ui.graphRotation)) ? Number(ui.graphRotation) : 0.04
        const bloom = ui.graphBloom !== false
        const glitch = ui.graphGlitch !== false
        const dustCount = Math.max(0, Math.min(240, Number(ui.graphDust) || 70))
        const ctx = canvas.getContext('2d')
        if (!ctx) return undefined
        const store = stateRef.current
        const cam = store.cam
        const FOCAL = 1100
        let width = 0
        let height = 0
        let dpr = 1
        let raf = 0
        let last = performance.now()
        const hash = (text) => {
          let value = 2166136261
          for (let index = 0; index < String(text).length; index += 1) {
            value ^= String(text).charCodeAt(index)
            value = Math.imul(value, 16777619) >>> 0
          }
          return value >>> 0
        }
        const rand = (text) => (hash(text) % 100000) / 100000
        const resize = () => {
          const rect = canvas.getBoundingClientRect()
          width = Math.max(320, rect.width)
          height = Math.max(320, rect.height)
          dpr = Math.min(2, window.devicePixelRatio || 1)
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        }
        const radiusOf = (node, weight) => {
          const w = Math.max(0.06, Math.min(1, Number(weight) || 0.3))
          if (node.kind === 'type') return 4 + Math.pow(w, 0.85) * 7
          if (node.kind === 'skill') return 4.5 + Math.pow(w, 0.9) * 5.5
          return 1.1 + Math.pow(w, 0.9) * 3.2
        }
        const project = (entry, time) => {
          const wx = entry.x + Math.sin(time / 3200 + entry.phase) * 7
          const wy = entry.y + Math.cos(time / 4100 + entry.phase) * 5
          const wz = entry.z + Math.sin(time / 2700 + entry.phase * 1.3) * 7
          const cy = Math.cos(cam.yaw)
          const sy = Math.sin(cam.yaw)
          const cp = Math.cos(cam.pitch)
          const sp = Math.sin(cam.pitch)
          const x1 = wx * cy - wz * sy
          const z1 = wx * sy + wz * cy
          const y1 = wy * cp - z1 * sp
          const z2 = wy * sp + z1 * cp
          const depth = cam.dist + z2
          const f = FOCAL / Math.max(180, depth)
          return { x: width / 2 + x1 * f, y: height / 2 + y1 * f, f, depth }
        }
        const layout = (data) => {
          const types = data.nodes.filter((node) => node.kind === 'type')
          const experiences = data.nodes.filter((node) => node.kind === 'experience')
          const skills = data.nodes.filter((node) => node.kind === 'skill')
          const centers = new Map()
          const total = Math.max(1, types.length)
          types.forEach((node, index) => {
            const y = total === 1 ? 0 : 1 - (index / (total - 1)) * 2
            const ring = Math.sqrt(Math.max(0, 1 - y * y))
            const phi = index * Math.PI * (3 - Math.sqrt(5)) + rand(node.id) * 0.5
            const radius = 240 + rand(`${node.id}r`) * 150
            centers.set(node.id, { x: Math.cos(phi) * ring * radius, y: y * radius * 0.78, z: Math.sin(phi) * ring * radius })
          })
          const positions = new Map()
          for (const node of types) positions.set(node.id, centers.get(node.id))
          const expByType = new Map()
          for (const node of experiences) {
            const key = `type:${node.typeId}`
            if (!expByType.has(key)) expByType.set(key, [])
            expByType.get(key).push(node)
          }
          for (const [key, list] of expByType) {
            const center = centers.get(key) || { x: 0, y: 0, z: 0 }
            for (const node of list) {
              const a = rand(`${node.id}a`) * Math.PI * 2
              const b = Math.acos(2 * rand(`${node.id}b`) - 1)
              const rr = 26 + Math.pow(rand(`${node.id}r`), 0.65) * 145
              positions.set(node.id, {
                x: center.x + Math.sin(b) * Math.cos(a) * rr,
                y: center.y + Math.cos(b) * rr * 0.72,
                z: center.z + Math.sin(b) * Math.sin(a) * rr,
              })
            }
          }
          for (const node of skills) {
            const derived = data.edges.filter((edge) => edge.target === node.id && edge.kind === 'derived').map((edge) => positions.get(edge.source)).filter(Boolean)
            let base = { x: 0, y: 0, z: 0 }
            if (derived.length > 0) {
              base = derived.reduce((sum, item) => ({ x: sum.x + item.x / derived.length, y: sum.y + item.y / derived.length, z: sum.z + item.z / derived.length }), { x: 0, y: 0, z: 0 })
            } else {
              const a = rand(`${node.id}a`) * Math.PI * 2
              const b = Math.acos(2 * rand(`${node.id}b`) - 1)
              const rr = 300 + rand(`${node.id}r`) * 90
              base = { x: Math.sin(b) * Math.cos(a) * rr, y: Math.cos(b) * rr * 0.8, z: Math.sin(b) * Math.sin(a) * rr }
            }
            const a = rand(`${node.id}a`) * Math.PI * 2
            positions.set(node.id, { x: base.x + Math.cos(a) * 46, y: base.y + (rand(`${node.id}y`) - 0.5) * 60, z: base.z + Math.sin(a) * 46 })
          }
          return positions
        }
        const sync = (data) => {
          const positions = layout(data)
          const seen = new Set()
          for (const node of data.nodes) {
            if (node.kind === 'root') continue
            seen.add(node.id)
            const shape = positions.get(node.id) || { x: 0, y: 0, z: 0 }
            const existing = store.nodes.get(node.id)
            if (existing) {
              existing.node = node
              existing.targetWeight = Number(node.weight) || 0.3
              existing.targetAlpha = 1
            } else {
              store.nodes.set(node.id, {
                node, x: shape.x, y: shape.y, z: shape.z,
                r: 0, alpha: 0, targetAlpha: 1,
                currentWeight: 0.08, targetWeight: Number(node.weight) || 0.3,
                phase: rand(`${node.id}p`) * Math.PI * 2, drift: 0.7 + rand(`${node.id}d`) * 0.8,
                screenX: 0, screenY: 0, screenF: 1, depth: 1,
              })
            }
          }
          for (const [id, entry] of store.nodes) if (!seen.has(id)) entry.targetAlpha = 0
          const seenEdges = new Set()
          for (const edge of data.edges) {
            const key = `${edge.source}->${edge.target}`
            seenEdges.add(key)
            const existing = store.edges.get(key)
            if (existing) {
              existing.edge = edge
              existing.targetStrength = Number(edge.strength) || 0.3
            } else {
              store.edges.set(key, {
                edge, currentStrength: 0, targetStrength: Number(edge.strength) || 0.3,
                particles: Array.from({ length: 1 + Math.round((Number(edge.strength) || 0.3) * 3) }, () => Math.random()),
              })
            }
          }
          for (const [key, edge] of store.edges) if (!seenEdges.has(key)) edge.targetStrength = 0
          while (store.dust.length < dustCount) {
            store.dust.push({
              x: Math.random(), y: Math.random(),
              vx: (Math.random() - 0.5) * 0.006, vy: (Math.random() - 0.5) * 0.004,
              size: 0.4 + Math.random() * 1.1, alpha: 0.03 + Math.random() * 0.12,
            })
          }
          store.dust.length = Math.min(store.dust.length, dustCount)
        }
        const pick = (clientX, clientY) => {
          const rect = canvas.getBoundingClientRect()
          const x = clientX - rect.left
          const y = clientY - rect.top
          let best = null
          let bestDistance = 26
          for (const [, entry] of store.nodes) {
            if (entry.alpha < 0.15) continue
            const distance = Math.hypot(entry.screenX - x, entry.screenY - y)
            if (distance < Math.max(bestDistance, entry.r + 6) && distance < bestDistance + entry.r) {
              best = entry
              bestDistance = distance
            }
          }
          return best
        }
        const onPointerDown = (event) => {
          store.dragging = { x: event.clientX, y: event.clientY, yaw: cam.yaw, pitch: cam.pitch }
          store.dragMoved = false
          canvas.style.cursor = 'grabbing'
        }
        const onPointerMove = (event) => {
          if (store.dragging) {
            const dx = event.clientX - store.dragging.x
            const dy = event.clientY - store.dragging.y
            if (Math.hypot(dx, dy) > 4) store.dragMoved = true
            cam.yaw = store.dragging.yaw + dx * 0.006
            cam.pitch = Math.max(-1.35, Math.min(1.35, store.dragging.pitch - dy * 0.006))
            return
          }
          if (event.target !== canvas) { store.hovered = null; return }
          const hit = pick(event.clientX, event.clientY)
          store.hovered = hit === null ? null : hit.node.id
          canvas.style.cursor = hit === null ? 'grab' : 'pointer'
        }
        const onPointerLeave = () => {
          store.hovered = null
          canvas.style.cursor = 'grab'
        }
        const onPointerUp = (event) => {
          if (store.dragging && !store.dragMoved) {
            const hit = pick(event.clientX, event.clientY)
            store.selected = hit === null ? null : hit.node.id
            store.pulse = 0
            setSelection(hit === null ? null : hit.node)
          }
          store.dragging = null
          canvas.style.cursor = 'grab'
        }
        const onWheel = (event) => {
          event.preventDefault()
          store.userZoom = true
          cam.dist = Math.min(3200, Math.max(520, cam.dist * (event.deltaY > 0 ? 1.08 : 0.92)))
        }
        resize()
        sync(graph.data)
        const fitCamera = () => {
          if (store.userZoom) return
          let bound = 1
          for (const entry of store.nodes.values()) bound = Math.max(bound, Math.hypot(entry.x, entry.y, entry.z))
          cam.dist = Math.max(900, Math.min(2800, bound * 2.9))
        }
        fitCamera()
        const refreshPalette = () => {
          if (paletteKey !== 'dsh') return
          palette = readDshGraphPalette(canvas)
        }
        let themeObserver = null
        try {
          themeObserver = new MutationObserver(refreshPalette)
          themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
          if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        } catch {
          themeObserver = null
        }
        const onResize = () => { resize(); fitCamera() }
        window.addEventListener('resize', onResize)
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        canvas.addEventListener('pointerdown', onPointerDown)
        canvas.addEventListener('pointerleave', onPointerLeave)
        canvas.addEventListener('wheel', onWheel, { passive: false })
        canvas.style.cursor = 'grab'
        let frameCount = 0
        const draw = (now) => {
          frameCount += 1
          if (frameCount % 30 === 0 && paletteKey === 'dsh') palette = readDshGraphPalette(canvas)
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          store.t += dt
          store.pulse += dt * 1.4
          if (rotation !== 0 && store.dragging === null) cam.yaw += rotation * dt
          const cx = width / 2
          const cy = height / 2
          ctx.clearRect(0, 0, width, height)
          for (const particle of store.dust) {
            particle.x += particle.vx * dt
            particle.y += particle.vy * dt
            if (particle.x < 0) particle.x += 1
            if (particle.x > 1) particle.x -= 1
            if (particle.y < 0) particle.y += 1
            if (particle.y > 1) particle.y -= 1
            ctx.globalAlpha = particle.alpha
            ctx.fillStyle = palette.dust
            ctx.beginPath()
            ctx.arc(particle.x * width, particle.y * height, particle.size, 0, Math.PI * 2)
            ctx.fill()
          }
          for (const entry of store.nodes.values()) {
            entry.currentWeight += (entry.targetWeight - entry.currentWeight) * Math.min(1, dt * 4)
            entry.alpha += (entry.targetAlpha - entry.alpha) * Math.min(1, dt * 4)
            entry.r += (radiusOf(entry.node, entry.currentWeight) - entry.r) * Math.min(1, dt * 6)
            const projected = project(entry, store.t)
            entry.screenX = projected.x
            entry.screenY = projected.y
            entry.screenF = projected.f
            entry.depth = projected.depth
          }
          const focusId = store.selected !== null ? store.selected : store.hovered
          const neighbors = new Set()
          if (focusId !== null) {
            neighbors.add(focusId)
            for (const edgeState of store.edges.values()) {
              if (edgeState.edge.source === focusId) neighbors.add(edgeState.edge.target)
              if (edgeState.edge.target === focusId) neighbors.add(edgeState.edge.source)
            }
          }
          const edgeList = [...store.edges.entries()].sort((left, right) => left[1].currentStrength - right[1].currentStrength)
          for (const [key, edgeState] of edgeList) {
            edgeState.currentStrength += (edgeState.targetStrength - edgeState.currentStrength) * Math.min(1, dt * 3)
            const from = store.nodes.get(edgeState.edge.source)
            const to = store.nodes.get(edgeState.edge.target)
            if (!from || !to) continue
            const strength = edgeState.currentStrength
            if (strength < 0.02 && edgeState.targetStrength === 0) { store.edges.delete(key); continue }
            if (strength < 0.02 || from.alpha < 0.1 || to.alpha < 0.1) continue
            const near = (from.screenF + to.screenF) * 0.5
            const bright = focusId !== null && (edgeState.edge.source === focusId || edgeState.edge.target === focusId)
            const relatedEdge = focusId === null || bright
            ctx.globalAlpha = Math.min(1, (0.025 + strength * 0.32) * near * (bright ? 1.9 : 1)) * (relatedEdge ? 1 : 0.1)
            const gradient = ctx.createLinearGradient(from.screenX, from.screenY, to.screenX, to.screenY)
            gradient.addColorStop(0, palette.nodeLight || palette.node)
            gradient.addColorStop(1, palette.edge || palette.node)
            ctx.strokeStyle = gradient
            ctx.lineWidth = (0.2 + strength * (bright ? 2.4 : 1.7)) * near
            ctx.shadowBlur = bloom ? (4 + strength * 10) * near : 0
            ctx.shadowColor = edgeState.edge.kind === 'derived' ? palette.node2 : palette.glow
            ctx.beginPath()
            ctx.moveTo(from.screenX, from.screenY)
            ctx.lineTo(to.screenX, to.screenY)
            ctx.stroke()
            if (strength > 0.12) {
              for (let index = 0; index < edgeState.particles.length; index += 1) {
                edgeState.particles[index] = (edgeState.particles[index] + dt * (0.06 + strength * 0.5)) % 1
                const progress = edgeState.particles[index]
                const px = from.screenX + (to.screenX - from.screenX) * progress
                const py = from.screenY + (to.screenY - from.screenY) * progress
                ctx.globalAlpha = (0.2 + strength * 0.55) * near
                ctx.fillStyle = palette.highlight
                ctx.beginPath()
                ctx.arc(px, py, (0.6 + strength * 1.3) * near, 0, Math.PI * 2)
                ctx.fill()
              }
            }
          }
          const ordered = [...store.nodes.values()].sort((left, right) => right.depth - left.depth)
          for (const entry of ordered) {
            if (entry.alpha <= 0.01) { if (entry.targetAlpha === 0) store.nodes.delete(entry.node.id); continue }
            const node = entry.node
            const isSelected = store.selected !== null && store.selected === node.id
            // 三类节点分开取色：经验=主色、类型=第二停靠点、技能=高亮色。
            // 这样主题渐变（多停靠点）才看得出来，不然图上一片单色。
            const color = node.kind === 'skill' ? (palette.highlight || palette.node) : node.kind === 'type' ? (palette.node2 || palette.node) : palette.node
            const breathing = node.recent ? 1 + Math.sin(store.t * 1.8 + entry.phase) * 0.09 : 1 + Math.sin(store.t * 0.9 + entry.phase) * 0.02
            const nearFactor = Math.min(1.6, Math.max(0.35, entry.screenF))
            let energy = 1
            if (node.kind === 'experience' && node.lastSeenAt) {
              const stamp = Date.parse(String(node.lastSeenAt))
              if (Number.isFinite(stamp)) {
                const days = Math.max(0, (Date.now() - stamp) / 86400000)
                energy = 0.45 + 0.55 * Math.exp(-days / 120)
              }
            }
            const related = focusId === null || neighbors.has(node.id)
            const alphaBase = entry.alpha * Math.min(1, 0.2 + entry.screenF * 0.85) * breathing * energy * (related ? 1 : 0.3)
            const screenRadius = Math.max(0.4, entry.r * entry.screenF * (0.85 + entry.currentWeight * 0.3))
            const paint = (offsetX, offsetY, alphaMultiplier) => {
              ctx.save()
              ctx.translate(entry.screenX + offsetX, entry.screenY + offsetY)
              ctx.globalAlpha = Math.max(0, Math.min(1, alphaBase * alphaMultiplier))
              ctx.shadowBlur = 0
              ctx.shadowColor = 'transparent'
              ctx.scale(breathing, breathing)
              // 恒星感 = 白热星心 + 本体色 + 十字星芒 + 很淡的外晕。
              // 之前外晕太浓太大、星心用中间调，叠在一起就成一团发霉的污渍。
              const glowColor = palette.glow || color
              const hot = lightenColor(color, palette.dark ? 0.55 : 0.72)
              const haloRadius = screenRadius * 2
              if (screenRadius > 1.6) {
                // 光晕和星芒用叠加混合：亮处更亮（星星是发光体），
                // 浅色主题上也不会叠出一片脏兮兮的暗晕。
                ctx.save()
                ctx.globalCompositeOperation = 'lighter'
                const halo = ctx.createRadialGradient(0, 0, screenRadius * 0.34, 0, 0, haloRadius)
                halo.addColorStop(0, withAlpha(glowColor, 0.3))
                halo.addColorStop(0.42, withAlpha(glowColor, 0.1))
                halo.addColorStop(1, withAlpha(glowColor, 0))
                ctx.fillStyle = halo
                ctx.beginPath()
                ctx.arc(0, 0, haloRadius, 0, Math.PI * 2)
                ctx.fill()
                // 小星点只给光晕，大一点的才加星芒，免得缩远后一片刺
                if (screenRadius > 3.2) drawStarFlare(ctx, screenRadius * 2.6, glowColor, 0.26)
                ctx.restore()
              }
              const core = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(0.6, screenRadius))
              core.addColorStop(0, withAlpha(hot, 0.98))
              core.addColorStop(0.5, withAlpha(color, 0.96))
              // 边缘留一点实色，别糊成一团：星星是「亮点 + 星芒」，不是一团雾
              core.addColorStop(1, withAlpha(color, 0.72))
              ctx.fillStyle = core
              ctx.strokeStyle = withAlpha(palette.highlight || color, 0.85)
              ctx.lineWidth = isSelected ? 1.6 : 0.6
              drawGraphShape(ctx, screenRadius, theme)
              if (screenRadius > 1.6) {
                // 星心那一点高光：整颗星最亮的位置，定出「光源在中心」
                ctx.fillStyle = withAlpha(hot, 0.95)
                ctx.beginPath()
                ctx.arc(0, 0, Math.max(0.7, screenRadius * 0.34), 0, Math.PI * 2)
                ctx.fill()
              }
              if (node.kind === 'skill') {
                ctx.beginPath()
                ctx.arc(0, 0, screenRadius * 1.9, 0, Math.PI * 2)
                ctx.strokeStyle = color
                ctx.lineWidth = 0.9
                ctx.stroke()
              }
              ctx.restore()
            }
            paint(0, 0, 1)
            if (glitch && (node.recent || isSelected)) {
              ctx.save()
              ctx.globalCompositeOperation = 'lighter'
              paint(1.4, 0, 0.16)
              ctx.restore()
            }
            if (isSelected) {
              const phase = store.pulse % 1
              ctx.save()
              ctx.globalAlpha = (1 - phase) * 0.75
              ctx.strokeStyle = palette.highlight
              ctx.lineWidth = 1.2
              ctx.beginPath()
              ctx.arc(entry.screenX, entry.screenY, screenRadius + 8 + phase * 52, 0, Math.PI * 2)
              ctx.stroke()
              ctx.restore()
            }
          }
          ctx.globalAlpha = 1
          ctx.shadowBlur = 0
          raf = requestAnimationFrame(draw)
        }
        raf = requestAnimationFrame(draw)
        return () => {
          cancelAnimationFrame(raf)
          window.removeEventListener('resize', onResize)
          window.removeEventListener('pointermove', onPointerMove)
          window.removeEventListener('pointerup', onPointerUp)
          if (themeObserver !== null) themeObserver.disconnect()
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointerleave', onPointerLeave)
          canvas.removeEventListener('wheel', onWheel)
        }
      }, [graph.data, settings.data])
      return h('div', { className: 'eng-graph-canvas-wrap' },
        h('canvas', { ref: canvasRef, className: 'eng-graph-canvas', 'aria-label': '3D 记忆海' }),
        h('div', { className: 'eng-graph-pill', role: 'group', 'aria-label': '关系图配色' },
          [['dsh', '跟随主题'], ['codex', '蓝紫星辰']].map(([key, label]) => h('button', {
            key,
            type: 'button',
            'data-tone': key,
            'data-active': paletteNow === key ? 'true' : 'false',
            title: key === 'codex' ? 'dsh-codex-effort-slider 那条推理滑条的蓝紫渐变' : '跟着当前 DSH 主题色走（换主题自动变）',
            onClick: () => pickPalette(key),
          }, label))),
        selection === null ? null : h('div', { className: 'eng-graph-detail' },
          h('div', { className: 'eng-graph-detail-meta' }, h(Badge, { tone: selection.kind === 'skill' ? 'warn' : selection.kind === 'type' ? 'brand' : outcomeOf(selection.outcome)[1] }, selection.kind === 'type' ? '类型' : selection.kind === 'skill' ? '技能' : '经验')),
          h('h3', { className: 'eng-graph-detail-title' }, selection.label || selection.id),
          h('dl', { className: 'eng-kv' },
            selection.kind === 'experience' ? h('dt', null, '结果') : null,
            selection.kind === 'experience' ? h('dd', null, `${outcomeOf(selection.outcome)[0]} · G ${fmtNumber(selection.G)}`) : null,
            selection.kind === 'skill' ? h('dt', null, '使用') : null,
            selection.kind === 'skill' ? h('dd', null, `uses ${selection.uses || 0} · helped ${selection.helped || 0} · hurt ${selection.hurt || 0}`) : null,
            selection.kind === 'type' ? h('dt', null, '经验数') : null,
            selection.kind === 'type' ? h('dd', null, String(selection.count || 0)) : null,
            h('dt', null, 'id'), h('dd', { className: 'eng-mono' }, String(selection.id || '').replace(/^(exp|skill|type):/, '')))))
    }

    function Settings(props) {
      const settings = useLoad(useCallback(() => request('/settings'), []))
      const validation = useLoad(useCallback(() => request('/validate'), []))
      const [rootInput, setRootInput] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [configDraft, setConfigDraft] = useState({})
      const [uiDraft, setUiDraft] = useState({})
      const [gitDraft, setGitDraft] = useState({})
      const [syncNotice, setSyncNotice] = useState('')
      const sync = useLoad(useCallback(() => request('/sync'), []))
      const [ghUser, setGhUser] = useState(null)
      const [ghRepos, setGhRepos] = useState(null)
      const [ghNotice, setGhNotice] = useState('')
      const [ghBusy, setGhBusy] = useState(false)
      const [newRepoName, setNewRepoName] = useState('')
      const [newRepoPrivate, setNewRepoPrivate] = useState(true)
      const [device, setDevice] = useState(null)
      const [repoSearch, setRepoSearch] = useState('')
      const [section, setSection] = useState(props && props.section ? String(props.section) : 'storage')
      const deviceStart = async () => {
        setGhBusy(true); setGhNotice('')
        try {
          const data = await request('/github', { method: 'POST', body: { action: 'device-start' } })
          setDevice({ ...data, status: 'waiting' })
          setGhNotice(`${data.opened ? '已打开浏览器' : '请手动打开浏览器'}，${data.copied ? '验证码已复制到剪贴板' : '验证码请手动复制'}`)
        } catch (caught) {
          setGhNotice(caught.message || String(caught))
        } finally {
          setGhBusy(false)
        }
      }
      const deviceCheckNow = async () => {
        setGhBusy(true); setGhNotice('')
        try {
          const data = await request('/github', { method: 'POST', body: { action: 'device-poll' } })
          if (data.status === 'authorized') {
            setDevice((previous) => (previous === null ? previous : { ...previous, status: 'authorized' }))
            if (data.user) setGhUser(data.user)
            setGhNotice(`已登录：${data.user && data.user.login ? data.user.login : 'GitHub'}`)
          } else if (data.status === 'expired' || data.status === 'denied') {
            setDevice((previous) => (previous === null ? previous : { ...previous, status: data.status }))
            setGhNotice(data.status === 'expired' ? '设备码过期了，重新点一次登录' : '授权被拒绝')
          } else {
            const waitSeconds = Math.ceil((Number(data.waitMs) || 0) / 1000)
            const label = data.status === 'slow-down' ? 'GitHub 要求放慢轮询' : '还没收到授权'
            setGhNotice(waitSeconds > 0 ? `${label}，${waitSeconds} 秒后可再检查` : `${label}，稍等再点，或等自动轮询`)
          }
        } catch (caught) {
          const message = caught.message || String(caught)
          if (/没有正在进行的登录/u.test(message)) {
            setDevice(null)
            setGhNotice('这个登录会话已失效（插件重载或超时），重新点一次「用 GitHub 登录」')
          } else {
            setGhNotice(message)
          }
        } finally {
          setGhBusy(false)
        }
      }
      const deviceCancel = async () => {
        try {
          await request('/github', { method: 'POST', body: { action: 'device-cancel' } })
        } catch {
          // 取消失败也没关系：状态机在 host 里
        }
        setDevice(null)
      }
      useEffect(() => {
        if (device === null || device.status !== 'waiting') return undefined
        let cancelled = false
        const interval = Math.max(5, Number(device.interval) || 5)
        const tick = async () => {
          try {
            const data = await request('/github', { method: 'POST', body: { action: 'device-poll' } })
            if (cancelled) return
            if (data.status === 'authorized') {
              setDevice((previous) => (previous === null ? previous : { ...previous, status: 'authorized' }))
              if (data.user) setGhUser(data.user)
              setGhNotice(`已登录：${data.user && data.user.login ? data.user.login : 'GitHub'}`)
              return
            }
            if (data.status === 'expired' || data.status === 'denied') {
              setDevice((previous) => (previous === null ? previous : { ...previous, status: data.status }))
              setGhNotice(data.status === 'expired' ? '设备码过期了，重新点一次登录' : '授权被拒绝')
            } else if (data.status === 'slow-down') {
              setDevice((previous) => (previous === null ? previous : { ...previous, interval: data.interval || previous.interval }))
              setGhNotice('GitHub 要求放慢轮询，已自动延长检查间隔')
            } else if (data.waitMs) {
              setGhNotice(`等待授权中：还差 ${Math.ceil((Number(data.waitMs) || 0) / 1000)} 秒才查下一次`)
            }
          } catch (caught) {
            if (cancelled) return
            const message = caught.message || String(caught)
            if (/没有正在进行的登录/u.test(message)) {
              setDevice(null)
              setGhNotice('这个登录会话已失效（插件重载或超时），重新点一次「用 GitHub 登录」')
            } else {
              setGhNotice(message)
            }
          }
        }
        tick()
        const timer = setInterval(tick, interval * 1000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [device === null ? null : device.userCode, device === null ? null : device.status])
      const ghRun = async (action, body, label) => {
        setGhBusy(true); setGhNotice('')
        try {
          const data = await request('/github', { method: 'POST', body: { action, ...body } })
          if (action === 'login') {
            setGhUser(data)
            setGhNotice(`已登录：${data.login}`)
          } else if (action === 'repos') {
            setGhRepos(Array.isArray(data.repos) ? data.repos : [])
            setGhNotice(`读到 ${data.repos ? data.repos.length : 0} 个仓库`)
          } else {
            // 注意别用 sync 当局部变量名——外层 `sync` 是 /sync 的 useLoad 句柄，
            // 之前这里 `const sync = data.sync` 把句柄遮盖成普通对象，sync.reload 直接 TypeError，
            // 用户只看到「sync.reload is not a function」，真正的推送失败原因被吞掉。
            const pushResult = data.sync || null
            const initResult = data.init || null
            try {
              await sync.reload()
            } catch (caught) {
              console.error('[engram] sync.reload failed', caught)
            }
            try {
              await settings.reload()
            } catch (caught) {
              console.error('[engram] settings.reload failed', caught)
            }
            if (initResult !== null && initResult.ok === false) {
              setGhNotice(`${label}：初始化失败 —— ${initResult.reason || '未知原因'}`)
            } else if (pushResult === null) {
              setGhNotice(`${label}：仓库已就绪，但还没推送（没有远端或初始化未完成）`)
            } else if (pushResult.ok) {
              setGhNotice(`${label}：已提交并推送${pushResult.commit ? `（${pushResult.commit}）` : ''}${pushResult.reason ? `；${pushResult.reason}` : ''}`)
            } else {
              setGhNotice(`${label}：推送没成功 —— ${pushResult.reason || '未知原因'}`)
            }
            if (action === 'create') setNewRepoName('')
          }
        } catch (caught) {
          setGhNotice(caught.message || String(caught))
        } finally {
          setGhBusy(false)
        }
      }
      useEffect(() => {
        if (!settings.data) return
        setRootInput(settings.data.currentRoot || settings.data.dataDir || '')
        setConfigDraft(settings.data.config || {})
        setUiDraft(settings.data.ui || {})
        setGitDraft(settings.data.git || {})
        if (settings.data.git && settings.data.git.login) setGhUser({ login: settings.data.git.login })
      }, [settings.data])
      const syncAction = async (action, label) => {
        setBusy(true); setSyncNotice('')
        try {
          const result = await request('/sync', { method: 'POST', body: { action } })
          await sync.reload()
          if (action === 'status') {
            setSyncNotice(result && result.isRepo
              ? `仓库就绪 · 分支 ${result.branch || '—'} · ${result.dirtyCount} 个未提交 · 领先 ${result.ahead} / 落后 ${result.behind}`
              : '还没初始化仓库：点「连接并同步」会顺手初始化')
            return
          }
          if (action === 'disconnect') {
            setSyncNotice('已断开仓库（本地提交历史与 GitHub 登录都保留）')
            return
          }
          const reason = result && typeof result.reason === 'string' ? result.reason : ''
          const overwriteNote = result && result.overwrote
            ? `（用本地覆盖了远端${result.backupRef ? `；旧远端 HEAD 存在 ${result.backupRef}` : ''}）`
            : ''
          setSyncNotice(reason === '' ? `${label}完成${overwriteNote}` : `${label}：${reason}${overwriteNote}`)
        } catch (caught) {
          setSyncNotice(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      const post = async (payload) => {
        setBusy(true); setNotice('')
        try {
          await request('/settings', { method: 'POST', body: payload })
          await Promise.all([settings.reload(), validation.reload()])
          if (props.onChanged) props.onChanged()
          setNotice('已保存')
        } catch (caught) {
          setNotice(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      // ── Git 同步（模仿记忆插件那块）：状态一行、操作一排、仓库直接连接，不用二次确认 ──
      const syncData = sync.data || null
      const gitUrlNow = String((syncData && syncData.remote) || (gitDraft && gitDraft.repoUrl) || '')
      const connectedNow = Boolean(syncData && syncData.configured)
      const branchNow = String((syncData && (syncData.branch || syncData.targetBranch)) || (gitDraft && gitDraft.branch) || 'main')
      const advancedGitFields = (((settings.data && settings.data.spec) || {}).git || []).filter((field) => ['repoUrl', 'branch', 'autoBackupMinutes'].indexOf(field.key) === -1)
      const filteredRepos = (ghRepos || []).filter((repo) => repoSearch.trim() === '' || String(repo.fullName || '').toLowerCase().includes(repoSearch.trim().toLowerCase()))
      const connectRepo = async () => {
        const url = String((gitDraft && gitDraft.repoUrl) || '').trim()
        if (url === '') {
          setGhNotice('先填仓库地址')
          return
        }
        setBusy(true); setGhNotice('')
        try {
          await request('/settings', { method: 'POST', body: { git: { ...gitDraft, repoUrl: url } } })
          await settings.reload()
          const pushed = await request('/sync', { method: 'POST', body: { action: 'push' } })
          await sync.reload()
          if (pushed && pushed.ok) setGhNotice(`已连接并同步${pushed.commit ? `（${pushed.commit}）` : ''}${pushed.reason ? `；${pushed.reason}` : ''}`)
          else setGhNotice(`已连接；推送没成功 —— ${(pushed && pushed.reason) || '未知原因'}`)
          if (props.onChanged) props.onChanged()
        } catch (caught) {
          setGhNotice(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      const saveAutoBackup = async (minutes) => {
        const next = { ...gitDraft, autoBackupMinutes: minutes }
        setGitDraft(next)
        setBusy(true); setSyncNotice('')
        try {
          await request('/settings', { method: 'POST', body: { git: next } })
          await Promise.all([settings.reload(), sync.reload()])
          setSyncNotice(minutes === 0 ? '自动同步已关闭' : `自动同步：每 ${minutes} 分钟`)
        } catch (caught) {
          setSyncNotice(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      const saveRoot = async (value) => {
        setBusy(true); setNotice('')
        try {
          await request('/settings', { method: 'POST', body: { currentRoot: value } })
          setNotice(value === '' ? '已恢复默认目录' : '已切换存储位置')
          await Promise.all([settings.reload(), validation.reload()])
          if (props.onChanged) props.onChanged()
        } catch (caught) {
          setNotice(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      const draftSetter = (setter) => (key, value) => setter((previous) => ({ ...previous, [key]: value }))
      const renderFields = (fields, draft, setDraft) => (fields || []).map((field) => {
        const value = draft[field.key]
        const update = draftSetter(setDraft)
        let control
        if (field.type === 'boolean') {
          control = h('label', { className: 'eng-actions', style: { fontWeight: 400 } },
            h('input', { type: 'checkbox', checked: value === true, onChange: (event) => update(field.key, event.target.checked) }),
            h('span', { className: 'eng-muted' }, value === true ? '开' : '关'))
        } else if (field.type === 'enum') {
          control = h('select', { className: 'eng-select', value: value === undefined ? '' : String(value), onChange: (event) => update(field.key, event.target.value) },
            h('option', { value: '' }, '默认'),
            (field.values || []).map((option) => h('option', { key: option, value: option }, (field.labels && field.labels[option]) || option)))
        } else if (field.type === 'number') {
          control = h('input', { className: 'eng-input', type: 'number', step: 'any', placeholder: '默认', value: value === undefined ? '' : String(value), onChange: (event) => update(field.key, event.target.value) })
        } else {
          control = h('input', { className: 'eng-input', placeholder: '默认', value: value === undefined ? '' : String(value), onChange: (event) => update(field.key, event.target.value) })
        }
        return h(Field, { key: field.key, label: field.label, hint: field.hint, tip: field.tip }, control)
      })
      if (settings.error) return h(Banner, { bad: true }, settings.error)
      const data = settings.data || {}
      const spec = data.spec || { config: [], ui: [], git: [] }
      const nav = [['storage', '存储位置'], ['backup', '备份与账号'], ['kernel', '内核参数'], ['ui', '界面与关系图'], ['maintenance', '维护']]
      const subnav = h('div', { className: 'eng-subnav' }, nav.map(([id, label]) => h('button', {
        key: id,
        type: 'button',
        className: 'eng-subnav-item',
        'data-active': section === id ? 'true' : 'false',
        onClick: () => setSection(id),
      }, label)))
      return h('div', { className: 'eng-fill eng-stack' },
        subnav,
        h('div', { className: 'eng-scroll eng-stack' },
        section === 'storage' ? [
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '存储位置'),
          h('div', { className: 'eng-muted', style: { marginBottom: 10 } }, '经验库根目录（包含 exp-lib.json 的 .exp 目录）；留空点「恢复默认」。'),
          h('div', { className: 'eng-actions', style: { marginBottom: 10 } },
            h('input', { className: 'eng-input', style: { flex: '1 1 320px' }, value: rootInput, onChange: (event) => setRootInput(event.target.value), placeholder: '例如：C:/Users/yh/WorkDeepSeek/.exp' }),
            h(Button, { kind: 'primary', disabled: busy || rootInput.trim() === '', onClick: () => saveRoot(rootInput.trim()) }, '切换'),
            h(Button, { disabled: busy, onClick: () => saveRoot('') }, '恢复默认')),
          notice ? h(Banner, null, notice) : null,
          h('dl', { className: 'eng-kv' },
            h('dt', null, '当前根'), h('dd', { className: 'eng-mono' }, data.currentRoot || '（未设置，用默认）'),
            h('dt', null, '生效目录'), h('dd', { className: 'eng-mono' }, data.dataDir || '—'),
            h('dt', null, '经验库文件'), h('dd', { className: 'eng-mono' }, data.file || '—'),
            h('dt', null, '大小'), h('dd', null, fmtBytes(data.bytes)),
            h('dt', null, '版本'), h('dd', null, data.version || '—')))
        ] : null,
        section === 'backup' ? [
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, 'Git 同步'),
          h('div', { className: 'eng-muted', style: { marginBottom: 12 } }, '把经验库当普通 git 仓库同步到远端：只提交当前数据目录，拉取只做 fast-forward，冲突交回给人。选好仓库就等于连上了，不用再点第二次。'),
          h('div', { className: 'eng-git-status' },
            h(Badge, { tone: connectedNow ? 'ok' : 'muted' }, connectedNow ? '已连接' : '未连接'),
            h('span', { className: 'eng-mono', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, connectedNow ? gitUrlNow : '选一个仓库，或填地址连接'),
            h('span', { className: 'eng-muted' }, `分支 ${branchNow}`),
            h('span', { className: 'eng-muted' }, String(gitDraft.pushStrategy || 'overwrite') === 'fast-forward' ? '策略：只允许快进' : '策略：本地覆盖云端'),
            syncData ? h('span', { className: 'eng-muted' }, `${syncData.dirtyCount} 个未提交`) : null,
            syncData && syncData.lastCommitAt ? h('span', { className: 'eng-muted' }, `上次同步 ${fmtTime(syncData.lastCommitAt)}`) : null),
          h('div', { className: 'eng-actions', style: { margin: '10px 0 14px' } },
            h(Button, { kind: 'primary', disabled: busy || !connectedNow, onClick: () => syncAction('push', '同步') }, '立即同步'),
            h(Button, { disabled: busy || !connectedNow, onClick: () => syncAction('pull', '拉取') }, '拉取'),
            h(Button, { disabled: busy, onClick: () => syncAction('status', '检查') }, '检查远端'),
            h(Button, { disabled: busy || !connectedNow, onClick: () => syncAction('disconnect', '断开') }, '断开')),
          h('div', { className: 'eng-label', style: { margin: '16px 0 8px' } }, 'GitHub 账号'),
          h('div', { className: 'eng-actions', style: { marginBottom: 8 } },
            device === null || device.status !== 'waiting'
              ? h(Button, { kind: ghUser ? undefined : 'primary', disabled: ghBusy, onClick: deviceStart }, ghUser ? '重新登录 GitHub' : '用 GitHub 登录')
              : h(Button, { disabled: ghBusy, onClick: deviceCancel }, '取消登录'),
            ghUser ? h(Badge, { tone: 'brand' }, `@${ghUser.login}`) : h('span', { className: 'eng-muted' }, '未登录'),
            h(Button, { disabled: ghBusy || ghUser === null, onClick: () => ghRun('repos', {}, '读取仓库') }, '刷新仓库列表')),
          device === null ? null : h('div', { className: 'eng-banner', style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 } },
            device.status === 'waiting'
              ? h('div', null,
                '在浏览器打开 ',
                h('a', { href: device.verificationUri || 'https://github.com/login/device', target: '_blank', rel: 'noreferrer' }, device.verificationUri || 'https://github.com/login/device'),
                '，输入设备码 ',
                h('span', { className: 'eng-mono', style: { fontWeight: 700, letterSpacing: '.08em' } }, device.userCode || ''),
                '；授权后会自动继续。',
                h('div', { className: 'eng-actions', style: { marginTop: 6 } },
                  h(Button, { small: true, onClick: async () => { try { await navigator.clipboard.writeText(device.userCode || ''); setGhNotice('设备码已复制') } catch { setGhNotice('浏览器不让复制，请手动选中设备码') } } }, '复制设备码'),
                  h(Button, { kind: 'primary', small: true, disabled: ghBusy, onClick: deviceCheckNow }, '我已授权，立即检查')))
              : device.status === 'authorized'
                ? '登录成功，令牌已保存在这台电脑'
                : `登录未完成：${device.status === 'expired' ? '设备码过期' : '授权被拒绝'}`),
          h('div', { className: 'eng-label', style: { margin: '4px 0 8px' } }, '仓库地址'),
          h('div', { className: 'eng-actions', style: { marginBottom: 8 } },
            h('input', { className: 'eng-input', style: { flex: '1 1 280px' }, placeholder: 'https://github.com/<你>/<仓库>.git', value: gitDraft.repoUrl || '', onChange: (event) => setGitDraft({ ...gitDraft, repoUrl: event.target.value }) }),
            h('input', { className: 'eng-input', style: { width: 120 }, placeholder: '分支', value: gitDraft.branch || '', onChange: (event) => setGitDraft({ ...gitDraft, branch: event.target.value }) }),
            h(Button, { disabled: busy || String(gitDraft.repoUrl || '').trim() === '', onClick: connectRepo }, '连接并同步')),
          h('div', { className: 'eng-label', style: { margin: '16px 0 8px' } }, '我的仓库'),
          h('div', { className: 'eng-actions', style: { marginBottom: 8 } },
            h('input', { className: 'eng-input', style: { flex: '1 1 240px' }, placeholder: '搜索仓库，或输入新仓库名', value: repoSearch, onChange: (event) => setRepoSearch(event.target.value) })),
          ghRepos === null
            ? h('div', { className: 'eng-muted', style: { padding: '4px 0 10px' } }, ghUser === null ? '登录 GitHub 后可以直接选仓库或新建' : '点「刷新仓库列表」读取仓库')
            : h('div', { className: 'eng-git-repos' }, filteredRepos.length === 0
              ? h('div', { className: 'eng-muted', style: { padding: '10px 12px' } }, ghRepos.length === 0 ? '这个账号还没有仓库，用下面的「新建并连接」' : '没有匹配的仓库')
              : filteredRepos.map((repo) => {
                const isCurrent = connectedNow && gitUrlNow === repo.cloneUrl
                return h('div', { key: repo.fullName, className: 'eng-git-repo' },
                  h('div', { className: 'eng-row-main' },
                    h('div', { className: 'eng-row-intent' }, repo.fullName),
                    h('div', { className: 'eng-row-sub' }, `${repo.private ? '私有' : '公开'} · ${repo.defaultBranch || 'main'} · ${fmtTime(repo.updatedAt)}`)),
                  isCurrent
                    ? h(Badge, { tone: 'ok' }, '当前')
                    : h(Button, { small: true, disabled: busy || ghBusy, onClick: () => ghRun('select', { repoUrl: repo.cloneUrl }, `连接 ${repo.fullName}`) }, '连接'))
              })),
          h('div', { className: 'eng-actions', style: { margin: '10px 0 4px' } },
            h('input', { className: 'eng-input', style: { flex: '1 1 200px' }, placeholder: '新仓库名，例如 engram-backup', value: newRepoName, onChange: (event) => setNewRepoName(event.target.value) }),
            h('label', { className: 'eng-actions', style: { fontWeight: 400 } },
              h('input', { type: 'checkbox', checked: newRepoPrivate, onChange: (event) => setNewRepoPrivate(event.target.checked) }),
              h('span', { className: 'eng-muted' }, newRepoPrivate ? '私有' : '公开')),
            h(Button, { kind: 'primary', disabled: busy || ghBusy || newRepoName.trim() === '', onClick: () => ghRun('create', { name: newRepoName.trim(), private: newRepoPrivate }, '新建并连接') }, '新建并连接')),
          h('div', { className: 'eng-label', style: { margin: '16px 0 8px' } }, '自动同步'),
          h('div', { className: 'eng-actions' },
            h('select', { className: 'eng-select', value: String(gitDraft.autoBackupMinutes === undefined ? 0 : gitDraft.autoBackupMinutes), onChange: (event) => saveAutoBackup(Number(event.target.value)) },
              [[0, '关闭（只手动同步）'], [60, '每小时'], [360, '每 6 小时'], [1440, '每天']].map(([value, label]) => h('option', { key: value, value: String(value) }, label))),
            h('span', { className: 'eng-muted' }, '到点自动 commit + push；没有改动就跳过')),
          h('div', { className: 'eng-label', style: { margin: '16px 0 8px' } }, '高级（令牌 / 提交作者）'),
          h('div', { className: 'eng-form-grid' }, renderFields(advancedGitFields, gitDraft, setGitDraft)),
          h('div', { className: 'eng-actions', style: { marginTop: 10 } }, h(Button, { disabled: busy, onClick: () => post({ git: gitDraft }) }, '保存高级设置')),
          syncNotice ? h(Banner, null, syncNotice) : null,
          ghNotice ? h(Banner, null, ghNotice) : null,
          sync.error ? h(Banner, { bad: true }, sync.error) : null)
        ] : null,

        section === 'ui' ? [
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '界面与关系图'),
          h('div', { className: 'eng-form-grid' }, renderFields(spec.ui, uiDraft, setUiDraft)),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy, onClick: () => post({ ui: uiDraft }) }, '保存数据源')))
        ] : null,
        section === 'kernel' ? [
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '内核参数'),
          h('div', { className: 'eng-muted', style: { marginBottom: 10 } }, '关系图主题/配色/旋转/泛光/浮尘都在「界面与关系图」里切换；内核算力参数保存后动态生效。'),
          h('div', { className: 'eng-form-grid' }, renderFields(spec.config, configDraft, setConfigDraft)),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy, onClick: () => post({ config: configDraft }) }, '保存内核参数')))
        ] : null,
        section === 'maintenance' ? [
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '技能校验'),
          validation.data && validation.data.problems && validation.data.problems.length > 0
            ? validation.data.problems.map((item) => h('div', { key: item.slug, className: 'eng-muted', style: { marginBottom: 6 } }, `${item.slug}：${item.problems.join('；')}`))
            : h('div', { className: 'eng-muted' }, '全部健康')),
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '运行信息'),
          h('dl', { className: 'eng-kv' },
            h('dt', null, '当前根'), h('dd', { className: 'eng-mono' }, data.currentRoot || '（未设置，用默认）'),
            h('dt', null, '生效目录'), h('dd', { className: 'eng-mono' }, data.dataDir || '—'),
            h('dt', null, '经验库文件'), h('dd', { className: 'eng-mono' }, data.file || '—'),
            h('dt', null, '大小'), h('dd', null, fmtBytes(data.bytes)),
            h('dt', null, '版本'), h('dd', null, data.version || '—')))
        ] : null))
    }

    const NAV = [
      ['overview', '概览', 'overview'],
      ['graph', '关系图', 'graph'],
      ['experiences', '经验', 'book'],
      ['recall', '检索', 'search'],
      ['record', '记录', 'plus'],
      ['skills', '技能', 'spark'],
      ['types', '类型', 'tag'],
      ['usage', '使用记录', 'clock'],
      ['settings', '设置', 'gear'],
    ]

    const PageBoundary = React.Component
      ? class PageBoundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { error: null }
          }
          static getDerivedStateFromError(error) {
            return { error }
          }
          render() {
            if (this.state.error !== null) {
              return h('div', { className: 'eng-banner eng-banner-bad' }, `页面渲染出错：${this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)}`)
            }
            return this.props.children
          }
        }
      : (props) => props.children

    function Console() {
      const [tab, setTab] = useState('overview')
      const [recallSeed, setRecallSeed] = useState('')
      const rootRef = useRef(null)
      const [fitHeight, setFitHeight] = useState(null)
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [refreshing, setRefreshing] = useState(false)
      const [refreshedAt, setRefreshedAt] = useState('')
      const [reloadToken, setReloadToken] = useState(0)
      // 「添加技能」弹层：只在技能页出现，放在顶部右侧、版本号左边。
      const [importOpen, setImportOpen] = useState(false)
      const loadState = useCallback(async () => {
        try {
          setState(await request('/state'))
          setError('')
        } catch (caught) {
          setError(caught.message || String(caught))
        }
      }, [])
      useEffect(() => { loadState() }, [loadState])
      // 顶部「刷新」= 重新拉整体状态 + 重挂当前页（页面自己的列表随之重新请求），
      // 并且必须给出可见回执：按钮转「刷新中…」、完成后显示「已刷新 hh:mm:ss」。
      const refreshAll = useCallback(async () => {
        setRefreshing(true)
        try {
          await loadState()
          setRefreshedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
          setReloadToken((token) => token + 1)
        } finally {
          setRefreshing(false)
        }
      }, [loadState])
      useEffect(() => {
        const measure = () => {
          const node = rootRef.current
          if (node === null || typeof window === 'undefined') return
          const top = node.getBoundingClientRect().top
          const available = Math.max(320, Math.round(window.innerHeight - top - 6))
          setFitHeight(available)
        }
        measure()
        window.addEventListener('resize', measure)
        let observer = null
        try {
          observer = new ResizeObserver(measure)
          if (rootRef.current !== null && rootRef.current.parentElement !== null) observer.observe(rootRef.current.parentElement)
        } catch {
          observer = null
        }
        return () => {
          window.removeEventListener('resize', measure)
          if (observer !== null) observer.disconnect()
        }
      }, [])
      const counts = {
        experiences: state ? state.totals.visible : null,
        skills: state ? state.totals.skills : null,
        types: state ? state.totals.types : null,
        usage: state && state.usage ? state.usage.total : null,
      }
      const go = (next) => setTab(next)
      const content = (() => {
        if (tab === 'overview') return h(Overview, { state, onGo: go, onOpen: (id) => { setTab('experiences') } })
        if (tab === 'graph') return h(Graph)
        if (tab === 'experiences') return h(Experiences, { state, onChanged: loadState, onSearch: (value) => { setRecallSeed(value); setTab('recall') } })
        if (tab === 'recall') return h(Recall, { seed: recallSeed })
        if (tab === 'record') return h(Record)
        if (tab === 'skills') return h(Skills, { onChanged: loadState })
        if (tab === 'types') return h(Types, { onChanged: loadState })
        if (tab === 'usage') return h(Usage)
        return h(Settings, { onChanged: loadState })
      })()
      const source = state && state.source
      const navButton = ([id, label, icon]) => h('button', {
        key: id,
        type: 'button',
        className: 'eng-nav-item',
        'data-active': tab === id ? 'true' : 'false',
        onClick: () => setTab(id),
      }, h(NavIcon, { name: icon }), label, counts[id] === null || counts[id] === undefined ? null : h('span', { className: 'eng-nav-count' }, String(counts[id])))
      const brandMark = h(EngramGlyph, { size: 18 })
      return h('div', { className: 'eng-app', ref: rootRef, style: fitHeight === null ? undefined : { height: `${fitHeight}px` } },
        h('aside', { className: 'eng-rail' },
          h('div', { className: 'eng-brand' },
            h('span', { className: 'eng-brand-mark' }, brandMark),
            h('div', null, h('div', { className: 'eng-brand-name' }, TITLE), h('div', { className: 'eng-brand-sub' }, 'ENG RAM'))),
          h('nav', { className: 'eng-nav' }, NAV.map(navButton)),
          h('div', { className: 'eng-rail-foot' },
            h('div', { className: 'eng-mono', style: { marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: state ? state.dataDir : '' }, state ? state.dataDir : '读取中…'),
            source && source.mode === 'mock' ? h('div', null, '示例数据（非真实库）') : null)),
        h('main', { className: 'eng-main' },
          h('header', { className: 'eng-top' },
            h('div', null, h('h1', { className: 'eng-title' }, TITLE), h('div', { className: 'eng-sub' }, '经验与技能的本地控制台')),
            h('div', { className: 'eng-top-right' },
              tab === 'skills' ? h(Button, { small: true, kind: 'primary', onClick: () => setImportOpen(true), title: '从外部导入一条技能（会开一个临时模型会话做分类/标签/排序）' }, '添加技能') : null,
              source && source.mode === 'mock' ? h(Badge, { tone: 'warn' }, '示例数据') : null,
              state ? h('span', { className: 'eng-muted' }, `v${state.version}`) : null,
              refreshedAt ? h('span', { className: 'eng-muted', title: '最近一次刷新完成时间' }, `已刷新 ${refreshedAt}`) : null,
              h(Button, { small: true, disabled: refreshing, onClick: refreshAll }, refreshing ? '刷新中…' : '刷新'))),
          h('div', {
            className: tab === 'graph' ? 'eng-content eng-content-full' : 'eng-content',
            'data-fill': tab === 'graph' ? 'false' : 'true',
          },
            error ? h(Banner, { bad: true }, error) : null,
            state && state.notice ? h(Banner, null, state.notice) : null,
            h(PageBoundary, { key: `${tab}:${reloadToken}` }, content))),
        importOpen
          ? h(ImportSkillDialog, {
            // 导入成功**不**重挂页面：refreshAll 会换 PageBoundary 的 key，弹窗会被一起卸载，
            // 用户就看不到导入结果了。改成关弹窗时再刷新。
            onClose: () => { setImportOpen(false); refreshAll() },
            onImported: () => {},
          })
          : null)
    }

    /**
     * 会话底部的「存入经验」按钮。
     * 聊天区可能在 shadow DOM 里，外部样式表进不去，所以全部用内联样式，
     * 尺寸/颜色/悬停都对齐旁边那些图标按钮（只留图标，不带文字和边框）。
     */
    function SaveExperienceAction(props) {
      const [state, setState] = useState('idle')
      const [hover, setHover] = useState(false)
      const [detail, setDetail] = useState('')
      const save = async (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        if (state === 'busy') return null
        setState('busy')
        try {
          const receipt = await request('/chat-save', {
            method: 'POST',
            body: { sessionId: props.sessionId || '', messageId: props.messageId || '' },
          })
          setState('ok')
          window.setTimeout(() => setState('idle'), 2500)
          return receipt
        } catch (error) {
          const message = error && error.message ? String(error.message) : String(error)
          setDetail(message)
          console.error('[engram] chat-save failed', message)
          setState('err')
          window.setTimeout(() => setState('idle'), 4000)
          return null
        }
      }
      const title = state === 'ok'
        ? '已存入经验库（控制台「经验」页可看到，结果待回填）'
        : state === 'err'
          ? `存入失败：${detail || '未知原因'}（点一下重试）`
          : '把这条对话存进经验库'
      // 和宿主 MessageIconActions 完全同一套尺寸/配色（28px 盒子、6px 内边距、radius-sm、tertiary 色、hover 变色）
      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 'calc(28px + var(--dsh-content-font-delta, 0px))',
        height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
        padding: '6px',
        margin: '0',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: hover && state !== 'busy' ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: state === 'err' ? 'var(--dsw-alias-label-error, #d24b45)' : state === 'busy' ? 'var(--dsw-alias-label-tertiary)' : hover ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
        opacity: state === 'busy' ? 0.45 : 1,
        cursor: state === 'busy' ? 'default' : 'pointer',
        font: 'inherit',
        lineHeight: 1,
      }
      const glyph = state === 'ok'
        ? h('svg', { width: 17, height: 17, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
          h('path', { d: 'M3.2 8.4 6.4 11.6 12.8 4.8' }))
        : h(EngramGlyph, { size: 17, strokeWidth: 1.5 })
      return h('button', {
        type: 'button',
        className: 'eng-save-exp',
        style,
        title,
        'aria-label': '存入经验库',
        'data-state': state,
        disabled: state === 'busy',
        onClick: save,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setHover(true),
        onBlur: () => setHover(false),
      }, glyph)
    }
    return {
      // 暴露给测试：详情面板/设置页/各页面都要能单独渲染，防「点击后空白」「设置页堆成一坨」「整页滚」回归。
      DetailPane,
      ImportSkillDialog,
      Console,
      Settings,
      Overview,
      Skills,
      Recall,
      Record,
      Types,
      Usage,
      Graph,
      SaveExperienceAction,
      parseGradientStops,
      graphStops,
      withAlpha,
      vividColor,
      colorSaturation,
      parseAllGradientStops,
      sliceLinearGradient,
      GRAPH_PALETTES,
      inject: ['slots', 'layout'],
      apply(ctx) {
        try {
          ensureStyles()
        } catch (error) {
          reportProbe('apply-throw', { errors: `styles:${error && error.message ? error.message : String(error)}` })
          throw error
        }
        const disposers = []
        const failures = []
        function PanelGlyph(props) {
          return h(EngramGlyph, { size: props && Number(props.size) > 0 ? Number(props.size) : 16 })
        }
        function BundleCard() {
          return h('div', { className: 'eng-card', style: { padding: 16 } },
            h('div', { className: 'eng-brand-name' }, TITLE),
            h('div', { className: 'eng-muted', style: { margin: '6px 0 12px' } }, '经验与技能的本地控制台：记录、检索、沉淀、校验。'),
            h(Button, { kind: 'primary', onClick: () => ctx.layout.selectPanel(PANEL_ID) }, '打开经验库'))
        }
        try {
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: () => TITLE }, PanelGlyph)))
        } catch (error) { failures.push(`panellist:${error && error.message ? error.message : String(error)}`); console.error('[engram] panellist registration failed', error) }
        try {
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Console)))
        } catch (error) { failures.push(`main:${error && error.message ? error.message : String(error)}`); console.error('[engram] main panel registration failed', error) }
        try {
          disposers.push(ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, BundleCard)))
        } catch (error) { failures.push(`card:${error && error.message ? error.message : String(error)}`); console.error('[engram] bundle card registration failed', error) }
        try {
          disposers.push(ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'save-experience',
            order: 95,
            inject: (sessionId) => ({ props: { sessionId } }),
          }, SaveExperienceAction)))
        } catch (error) { failures.push(`chat-save:${error && error.message ? error.message : String(error)}`); console.error('[engram] chat save registration failed', error) }
        try {
          ctx.effect(() => () => {
            for (const dispose of disposers.reverse()) {
              try { dispose() } catch (error) { console.error('[engram] dispose failed', error) }
            }
          })
        } catch (error) {
          failures.push(`effect:${error && error.message ? error.message : String(error)}`)
        }
        reportProbe('apply', { panels: disposers.length, errors: failures.join('|').slice(0, 300) })
      },
    }
  },
})
