/**
 * 经验库控制台（dsh-exp-ui client）
 *
 * 八个页面覆盖内核全部能力：概览 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置。
 * 只通过 `/exp-ui/api/*` 访问数据；mock 与 live 返回形状一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-engram-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'exp-ui'
    const PACKAGE_NAME = 'dsh-engram'
    const TITLE = '经验库'
    const API = '/exp-ui/api'

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    const STYLE_ID = 'dsh-engram/styles'
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
.eng-empty { padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
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
@container (max-width: 980px) { .eng-cols, .eng-split { grid-template-columns: minmax(0, 1fr); } .eng-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 680px) { .eng-rail { width: 100%; flex: 0 0 auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); overflow: visible; } .eng-brand { padding: 0 10px 0 2px; } .eng-brand-sub { display: none; } .eng-nav { flex-direction: row; flex-wrap: wrap; } .eng-nav-item { width: auto; padding: 6px 9px; } .eng-nav-count, .eng-rail-foot, .eng-nav-sep { display: none; } .eng-content { padding: 14px; } .eng-top { padding: 10px 14px; } .eng-form-grid { grid-template-columns: minmax(0, 1fr); } .eng-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 1180px) { .eng-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .eng-cols, .eng-split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 860px) { .eng-app { flex-direction: column; } .eng-rail { width: 100%; flex: 0 0 auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); } .eng-brand { padding: 0 10px 0 2px; } .eng-brand-sub { display: none; } .eng-nav { flex-direction: row; flex-wrap: wrap; } .eng-nav-item { width: auto; padding: 6px 9px; } .eng-nav-count, .eng-rail-foot, .eng-nav-sep { display: none; } .eng-content { padding: 14px; } .eng-top { padding: 10px 14px; } .eng-form-grid { grid-template-columns: minmax(0, 1fr); } }
@keyframes eng-dash { to { stroke-dashoffset: -10; } }
.eng-graph { position: relative; padding: 10px 12px 8px; background: radial-gradient(760px 460px at 50% 42%, color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent), transparent 72%), var(--dsw-alias-bg-layer-2); }
.eng-graph svg { width: 100%; height: auto; display: block; }
.eng-graph-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 2px 6px 6px; }
.eng-graph-legend { display: flex; gap: 12px; flex-wrap: wrap; padding: 4px 8px 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.eng-graph-node { cursor: pointer; }
.eng-graph-node:hover circle, .eng-graph-node:hover rect { filter: drop-shadow(0 0 7px currentColor); }
.eng-graph-label { fill: var(--dsw-alias-label-primary); font-size: 10px; paint-order: stroke; stroke: var(--dsw-alias-bg-layer-1); stroke-width: 3px; }
.eng-graph-label-sub { fill: var(--dsw-alias-label-secondary); font-size: 9px; }
.eng-graph-edge { stroke: var(--dsw-alias-border-l1); fill: none; }
.eng-graph-edge-derived { stroke-dasharray: 4 4; animation: eng-dash 1.5s linear infinite; }
@media (prefers-reduced-motion: reduce) { .eng-nav-item, .eng-row, .eng-skill-row { transition: none; } }
/* ---- Cyberpunk skin ---- */
.eng-app {
  --eng-bg: #04060c;
  --eng-panel: #080d18;
  --eng-line: rgba(0, 240, 255, .16);
  --eng-text: #d7e6ff;
  --eng-dim: #7486ad;
  --eng-cyan: #00f0ff;
  --eng-magenta: #ff2bd6;
  --eng-lime: #a6ff00;
  --eng-amber: #ffb800;
  --eng-red: #ff3b5c;
  position: relative;
  background:
    radial-gradient(1100px 560px at 88% -12%, rgba(255, 43, 214, .16), transparent 62%),
    radial-gradient(900px 520px at -8% 108%, rgba(0, 240, 255, .13), transparent 60%),
    linear-gradient(180deg, #04060c 0%, #070b14 100%);
  color: var(--eng-text);
  font-family: "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
}
.eng-app::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: repeating-linear-gradient(0deg, rgba(255, 255, 255, .025) 0 1px, transparent 1px 3px);
  mix-blend-mode: screen;
}
.eng-app > * { position: relative; z-index: 1; }
.eng-rail {
  background: linear-gradient(180deg, rgba(6, 10, 20, .96), rgba(3, 5, 10, .99));
  border-right: 1px solid var(--eng-line);
  box-shadow: inset -1px 0 0 rgba(255, 43, 214, .12);
}
.eng-brand-mark {
  color: var(--eng-cyan);
  background: rgba(0, 240, 255, .08);
  border: 1px solid rgba(0, 240, 255, .45);
  box-shadow: 0 0 18px rgba(0, 240, 255, .28);
  clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
}
.eng-brand-name { color: var(--eng-cyan); text-shadow: 0 0 12px rgba(0, 240, 255, .6); letter-spacing: .12em; }
.eng-brand-sub { color: var(--eng-magenta); letter-spacing: .32em; text-shadow: 0 0 10px rgba(255, 43, 214, .55); }
.eng-nav-item { color: var(--eng-dim); border-left: 2px solid transparent; border-radius: 2px; }
.eng-nav-item:hover { color: var(--eng-cyan); background: rgba(0, 240, 255, .06); border-left-color: rgba(0, 240, 255, .5); }
.eng-nav-item[data-active="true"] {
  color: var(--eng-cyan);
  background: linear-gradient(90deg, rgba(0, 240, 255, .14), rgba(255, 43, 214, .06));
  border-left-color: var(--eng-cyan);
  box-shadow: inset 0 0 0 1px rgba(0, 240, 255, .18), 0 0 18px rgba(0, 240, 255, .10);
  text-shadow: 0 0 10px rgba(0, 240, 255, .6);
}
.eng-nav-count { color: var(--eng-magenta); opacity: .95; }
.eng-rail-foot { color: var(--eng-dim); border-top-color: var(--eng-line); }
.eng-top {
  background: rgba(4, 7, 13, .78);
  border-bottom: 1px solid var(--eng-line);
  box-shadow: 0 1px 0 rgba(255, 43, 214, .12);
}
.eng-title { color: var(--eng-text); font-size: 15px; letter-spacing: .34em; text-transform: uppercase; text-shadow: 0 0 14px rgba(0, 240, 255, .45); }
.eng-sub { color: var(--eng-dim); letter-spacing: .08em; }
.eng-card {
  background: linear-gradient(150deg, rgba(11, 18, 33, .94), rgba(5, 8, 15, .97));
  border: 1px solid var(--eng-line);
  box-shadow: 0 12px 34px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255, 255, 255, .035), 0 0 0 1px rgba(0, 0, 0, .35);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
}
.eng-card:hover { border-color: rgba(0, 240, 255, .28); }
.eng-kpi-label { color: var(--eng-cyan); letter-spacing: .18em; }
.eng-kpi-value { color: #f2f8ff; text-shadow: 0 0 18px rgba(0, 240, 255, .35); }
.eng-kpi-unit { color: var(--eng-magenta); }
.eng-section-title { color: var(--eng-cyan); letter-spacing: .12em; text-transform: uppercase; font-size: 12px; }
.eng-muted { color: var(--eng-dim); }
.eng-btn {
  background: rgba(0, 240, 255, .04);
  border: 1px solid rgba(0, 240, 255, .35);
  border-radius: 2px;
  color: var(--eng-cyan);
  letter-spacing: .06em;
  clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
}
.eng-btn:hover { background: rgba(0, 240, 255, .12); border-color: var(--eng-cyan); box-shadow: 0 0 16px rgba(0, 240, 255, .22); }
.eng-btn-primary { background: linear-gradient(90deg, var(--eng-magenta), #b13bff 55%, var(--eng-cyan)); border-color: transparent; color: #04060c; font-weight: 700; box-shadow: 0 0 22px rgba(255, 43, 214, .35); }
.eng-btn-primary:hover { filter: brightness(1.12); box-shadow: 0 0 28px rgba(255, 43, 214, .5); }
.eng-btn-danger { color: var(--eng-red); border-color: rgba(255, 59, 92, .5); }
.eng-input, .eng-select, .eng-textarea {
  background: rgba(0, 240, 255, .035);
  border: 1px solid rgba(0, 240, 255, .22);
  color: var(--eng-text);
  border-radius: 2px;
  font-family: inherit;
}
.eng-input::placeholder, .eng-textarea::placeholder { color: rgba(116, 134, 173, .65); }
.eng-input:focus, .eng-select:focus, .eng-textarea:focus { outline: none; border-color: var(--eng-cyan); box-shadow: 0 0 0 1px rgba(0, 240, 255, .35), 0 0 18px rgba(0, 240, 255, .18); }
.eng-label { color: var(--eng-cyan); letter-spacing: .1em; text-transform: uppercase; }
.eng-badge { border-radius: 2px; border: 1px solid currentColor; background: rgba(0, 0, 0, .35); letter-spacing: .04em; text-shadow: 0 0 10px currentColor; }
.eng-row { border-bottom-color: rgba(0, 240, 255, .10); }
.eng-row:hover { background: rgba(0, 240, 255, .06); }
.eng-row[data-on="true"] { background: linear-gradient(90deg, rgba(255, 43, 214, .10), rgba(0, 240, 255, .06)); box-shadow: inset 2px 0 0 var(--eng-magenta); }
.eng-row-intent { color: #eaf4ff; }
.eng-row-sub { color: var(--eng-dim); }
.eng-table th { color: var(--eng-cyan); border-bottom-color: rgba(0, 240, 255, .22); letter-spacing: .12em; text-transform: uppercase; }
.eng-table td { border-bottom-color: rgba(0, 240, 255, .08); color: var(--eng-text); }
.eng-table tr:hover td { background: rgba(0, 240, 255, .04); }
.eng-pre { background: rgba(0, 0, 0, .45); border-color: rgba(0, 240, 255, .22); color: #b9ffe9; }
.eng-banner { background: rgba(0, 240, 255, .05); border-color: rgba(0, 240, 255, .2); color: var(--eng-dim); }
.eng-banner-bad { border-color: rgba(255, 59, 92, .45); color: var(--eng-red); background: rgba(255, 59, 92, .06); }
.eng-empty { color: var(--eng-dim); }
.eng-kv dt { color: var(--eng-cyan); }
.eng-kv dd { color: var(--eng-text); }
.eng-mono { color: #9ff7ff; text-shadow: 0 0 8px rgba(0, 240, 255, .35); }
.eng-graph {
  background:
    radial-gradient(620px 420px at 50% 42%, rgba(255, 43, 214, .14), transparent 66%),
    radial-gradient(760px 520px at 18% 84%, rgba(0, 240, 255, .12), transparent 62%),
    #03050b;
  border-color: rgba(255, 43, 214, .26);
  overflow: hidden;
}
.eng-graph::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, transparent 0%, rgba(0, 240, 255, .07) 49%, transparent 50%);
  background-size: 100% 220px;
  animation: eng-scan 6s linear infinite;
  opacity: .5;
}
@keyframes eng-scan { from { background-position: 0 -220px; } to { background-position: 0 680px; } }
.eng-graph-head strong { color: var(--eng-magenta); letter-spacing: .16em; text-transform: uppercase; text-shadow: 0 0 12px rgba(255, 43, 214, .5); }
.eng-graph-legend { color: var(--eng-dim); }
.eng-graph-edge { stroke: rgba(0, 240, 255, .3); }
.eng-graph-edge-derived { stroke: var(--eng-magenta); }
.eng-graph-label { fill: #d7e6ff; stroke: #03050b; }
.eng-graph-label-sub { fill: var(--eng-dim); }
.eng-graph-node circle, .eng-graph-node rect { transition: filter .16s ease, transform .16s ease; transform-box: fill-box; transform-origin: center; }
.eng-graph-node:hover circle, .eng-graph-node:hover rect { filter: drop-shadow(0 0 8px currentColor) drop-shadow(0 0 16px currentColor); transform: scale(1.18); }
.eng-graph-ring { fill: none; stroke: var(--eng-cyan); opacity: .35; transform-box: fill-box; transform-origin: center; animation: eng-pulse 3.2s ease-out infinite; }
.eng-graph-ring-2 { stroke: var(--eng-magenta); animation-delay: 1.2s; }
@keyframes eng-pulse { 0% { transform: scale(.8); opacity: .45; } 70% { transform: scale(1.25); opacity: 0; } 100% { transform: scale(1.25); opacity: 0; } }

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
    function Field(props) {
      return h('div', { className: 'eng-field', style: props.wide ? { gridColumn: '1 / -1' } : undefined },
        props.label ? h('label', { className: 'eng-label' }, props.label) : null,
        props.children,
        props.hint ? h('span', { className: 'eng-muted' }, props.hint) : null)
    }
    function Empty(props) {
      return h('div', { className: 'eng-empty' }, props.children || '暂无数据')
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
      return h('div', null,
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
              h('div', { className: 'eng-muted', style: { marginTop: 10 } }, state.notice || `共 ${totals.types || 0} 个类型`)))))
    }

    function Experiences(props) {
      const [searchDraft, setSearchDraft] = useState('')
      const [type, setType] = useState('')
      const [outcome, setOutcome] = useState('')
      const [selected, setSelected] = useState(null)
      const list = useLoad(useCallback(() => {
        const params = new URLSearchParams({ limit: '100' })
        if (type !== '') params.set('type', type)
        if (outcome !== '') params.set('outcome', outcome)
        return request(`/experiences?${params.toString()}`)
      }, [type, outcome]))
      const detail = useLoad(useCallback(() => selected === null ? Promise.resolve(null) : request(`/experience?id=${encodeURIComponent(selected)}`), [selected]))
      const types = (props.state && props.state.types) || []
      const rows = (list.data && (list.data.rows || list.data.candidates)) || []
      const send = async (result) => {
        if (selected === null) return
        await request('/feedback', { method: 'POST', body: { id: selected, result } })
        await Promise.all([list.reload(), detail.reload()])
        props.onChanged()
      }
      return h('div', null,
        list.error ? h(Banner, { bad: true }, list.error) : null,
        h('div', { className: 'eng-toolbar' },
          h('input', { className: 'eng-input', placeholder: '按意图检索（回车跳到检索页）…', value: searchDraft, onChange: (event) => setSearchDraft(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && searchDraft.trim() !== '') props.onSearch(searchDraft.trim()) } }),
          h('select', { className: 'eng-select', value: type, onChange: (event) => setType(event.target.value) },
            h('option', { value: '' }, '全部类型'), types.map((item) => h('option', { key: item.id, value: item.id }, item.name))),
          h('select', { className: 'eng-select', value: outcome, onChange: (event) => setOutcome(event.target.value) },
            h('option', { value: '' }, '全部结果'), Object.keys(OUTCOMES).map((key) => h('option', { key, value: key }, OUTCOMES[key][0]))),
          h('span', { className: 'eng-muted' }, `${list.data ? list.data.total : '—'} 条`),
          h(Button, { small: true, disabled: searchDraft.trim() === '', onClick: () => props.onSearch(searchDraft.trim()) }, '检索'),
          h(Button, { small: true, onClick: list.reload }, '刷新')),
        h('div', { className: 'eng-split' },
          h('div', { className: 'eng-card' },
            rows.length === 0 ? h(Empty, null, list.loading ? '读取中…' : '没有符合条件的经验') : h('div', { className: 'eng-list' }, rows.map((row) => {
              const [label, tone] = outcomeOf(row.outcome)
              return h('div', { key: row.id, className: 'eng-row', 'data-on': selected === row.id ? 'true' : 'false', onClick: () => setSelected(row.id) },
                h(Badge, { tone }, label),
                h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || '（无意图）'), h('div', { className: 'eng-row-sub' }, `${row.typeName || '未分类'} · ${row.action || '—'}`)),
                h('span', { className: 'eng-mono' }, `G ${fmtNumber(row.G)}`),
                h('span', { className: 'eng-muted' }, fmtTime(row.lastSeenAt || row.ts)))
            }))),
          h('div', { className: 'eng-card' },
            selected === null ? h(Empty, null, '选一条经验看详情') : detail.data === null ? h(Empty, null, '读取中…') : detail.error ? h(Banner, { bad: true }, detail.error) : (() => {
              const row = detail.data.row
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
                  h(Button, { small: true, onClick: () => send('neutral') }, '中性')))
            }))))
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
      return h('div', null,
        error ? h(Banner, { bad: true }, error) : null,
        h('div', { className: 'eng-card', style: { padding: 16, marginBottom: 14 } },
          h('div', { className: 'eng-form-grid' },
            h(Field, { label: '意图', wide: true, hint: '走内核 JitRL 召回（技能模式优先返回技能正文）' },
              h('textarea', { className: 'eng-textarea', placeholder: '例如：把课件导出成 PDF，字体要嵌进去', value: intent, onChange: (event) => setIntent(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) run() } })),
            h(Field, { label: '情境（逗号分隔，可选）' }, h('input', { className: 'eng-input', placeholder: 'windows, powerpoint', value: context, onChange: (event) => setContext(event.target.value) }))),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy || intent.trim() === '', onClick: run }, busy ? '检索中…' : '检索'))),
        result === null ? null : h('div', null,
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
                h('div', { className: 'eng-muted', style: { marginTop: 4 } }, item.action || '—'))))))
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
      return h('div', { className: 'eng-card', style: { padding: 18 } },
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
        h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy || form.intent.trim() === '' || form.action.trim() === '', onClick: submit }, busy ? '提交中…' : '记录')))
    }

    function Skills(props) {
      const skills = useLoad(useCallback(() => request('/skills'), []))
      const validation = useLoad(useCallback(() => request('/validate'), []))
      const [selected, setSelected] = useState(null)
      const [intent, setIntent] = useState('')
      const [context, setContext] = useState('')
      const [notice, setNotice] = useState('')
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
      return h('div', null,
        skills.error ? h(Banner, { bad: true }, skills.error) : null,
        notice ? h(Banner, null, notice) : null,
        h('div', { className: 'eng-split' },
          h('div', { className: 'eng-card' },
            rows.length === 0 ? h(Empty, null, '还没有固化技能：至少 3 条同族经验（含正负对照）后沉淀') : rows.map((row) => {
              const [label, tone] = skillStateOf(row.status)
              return h('div', { key: row.id, className: 'eng-skill-row', 'data-on': selected === row.id ? 'true' : 'false', onClick: () => setSelected(row.id) },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { className: 'eng-skill-name' }, row.name),
                  h('div', { className: 'eng-skill-desc' }, row.description || '—'),
                  h('div', { className: 'eng-actions', style: { marginTop: 6 } },
                    h(Badge, { tone }, label),
                    h('span', { className: 'eng-muted' }, `uses ${row.uses || 0} · helped ${row.helped || 0} · hurt ${row.hurt || 0}`),
                    row.pendingCommit ? h(Badge, { tone: 'warn' }, '待补提交') : null)),
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
            current === null ? h('div', { className: 'eng-card' }, h(Empty, null, '选一个技能看正文')) : h('div', { className: 'eng-card' },
              h('div', { className: 'eng-detail' },
                h('h3', { className: 'eng-detail-title' }, current.name),
                h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, current.description || '—'),
                h('div', { className: 'eng-actions', style: { marginBottom: 10 } },
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id, result: 'helped' } }); return '已记「有帮助」' }) }, '有帮助'),
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id, result: 'hurt' } }); return '已记「没帮上」' }) }, '没帮上'),
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id, result: 'neutral' } }); return '已记「中性」' }) }, '中性')),
                h('pre', { className: 'eng-pre' }, current.body || '（空）'))))))
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
      return h('div', null,
        types.error ? h(Banner, { bad: true }, types.error) : null,
        notice ? h(Banner, null, notice) : null,
        h('div', { className: 'eng-card', style: { padding: 15, marginBottom: 14 } },
          h('div', { className: 'eng-form-grid' },
            h(Field, { label: '新类型名称' }, h('input', { className: 'eng-input', value: name, onChange: (event) => setName(event.target.value) })),
            h(Field, { label: '描述（可选）' }, h('input', { className: 'eng-input', value: description, onChange: (event) => setDescription(event.target.value) }))),
          h(Button, { kind: 'primary', disabled: name.trim() === '', onClick: () => op({ action: 'create', name: name.trim(), description: description.trim() }) }, '新建类型')),
        h('div', { className: 'eng-card' },
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
      return h('div', null,
        usage.error ? h(Banner, { bad: true }, usage.error) : null,
        h('div', { className: 'eng-card' }, rows.length === 0 ? h(Empty, null, usage.loading ? '读取中…' : '还没有调用记录') : h('table', { className: 'eng-table' },
          h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '工具'), h('th', null, '意图'), h('th', null, '结果'))),
          h('tbody', null, rows.map((row, index) => h('tr', { key: index },
            h('td', { className: 'eng-mono' }, fmtTime(row.at)),
            h('td', null, row.tool || '—'),
            h('td', null, row.intent || row.action || '—'),
            h('td', null, row.feedback || (row.ok === false ? '失败' : 'ok'))))))))
    }

    function Graph() {
      const graph = useLoad(useCallback(() => request('/graph'), []))
      const [active, setActive] = useState(null)
      if (graph.error) return h(Banner, { bad: true }, graph.error)
      const data = graph.data
      if (!data) return h('div', { className: 'eng-card' }, h(Empty, null, '读取关系数据…'))
      const nodes = (data.nodes || []).filter((node) => node.kind !== 'root')
      const types = nodes.filter((node) => node.kind === 'type')
      const experiences = nodes.filter((node) => node.kind === 'experience')
      const skills = nodes.filter((node) => node.kind === 'skill')
      const center = { x: 450, y: 310 }
      const pos = new Map()
      const angles = new Map()
      types.forEach((type, index) => {
        const angle = (-90 + (index * 360) / Math.max(1, types.length)) * (Math.PI / 180)
        pos.set(type.id, { x: center.x + Math.cos(angle) * 150, y: center.y + Math.sin(angle) * 150 })
        angles.set(type.id, angle)
      })
      const groups = new Map()
      for (const experience of experiences) {
        const key = experience.typeId || 'ty_other'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(experience)
      }
      groups.forEach((list, typeId) => {
        const base = angles.has(typeId) ? angles.get(typeId) : 0
        const spread = Math.min(1.1, 0.22 * list.length)
        list.forEach((experience, index) => {
          const angle = base + (list.length === 1 ? 0 : -spread / 2 + (spread * index) / (list.length - 1))
          pos.set(experience.id, { x: center.x + Math.cos(angle) * 238, y: center.y + Math.sin(angle) * 238 })
        })
      })
      skills.forEach((skill, index) => {
        const derived = (data.edges || []).filter((edge) => edge.kind === 'derived' && edge.target === skill.id && pos.has(edge.source)).map((edge) => pos.get(edge.source))
        const base = derived.length > 0 ? Math.atan2(derived[0].y - center.y, derived[0].x - center.x) : (-90 + (index * 360) / Math.max(1, skills.length)) * (Math.PI / 180)
        const radius = 312 + (index % 3) * 16
        pos.set(skill.id, { x: center.x + Math.cos(base) * radius, y: center.y + Math.sin(base) * radius })
      })
      const colorOf = (node) => {
        if (node.kind === 'type') return '#00f0ff'
        if (node.kind === 'skill') return '#ff2bd6'
        if (node.outcome === 'success' || node.outcome === 'accepted') return '#39ff88'
        if (node.outcome === 'partial') return '#ffd166'
        if (node.outcome === 'failed' || node.outcome === 'corrected' || node.outcome === 'rejected') return '#ff3b5c'
        return '#6c7a99'
      }
      const pathOf = (edge) => {
        const from = edge.source === 'root' ? center : pos.get(edge.source)
        const to = pos.get(edge.target)
        if (!from || !to) return null
        const midX = (from.x + to.x) / 2
        const midY = (from.y + to.y) / 2
        const dx = to.x - from.x
        const dy = to.y - from.y
        const length = Math.hypot(dx, dy) || 1
        const bend = edge.kind === 'derived' ? 26 : 12
        const controlX = midX - (dy / length) * bend
        const controlY = midY + (dx / length) * bend
        return `M${from.x},${from.y} Q${controlX},${controlY} ${to.x},${to.y}`
      }
      const selected = active === null ? null : nodes.find((node) => node.id === active) || null
      return h('div', { className: 'eng-stack' },
        h('div', { className: 'eng-card eng-graph' },
          h('div', { className: 'eng-graph-head' },
            h('strong', null, '类型 → 经验 → 技能'),
            h('span', { className: 'eng-muted' }, `${data.summary.types} 类型 · ${data.summary.experiences} 经验 · ${data.summary.skills} 技能`)),
          h('svg', { viewBox: '0 0 900 620', role: 'img', 'aria-label': '经验关系图' },
            h('defs', null,
              h('radialGradient', { id: 'engRootGlow' }, h('stop', { offset: '0%', stopColor: 'var(--eng-cyan)', stopOpacity: '0.55' }), h('stop', { offset: '100%', stopColor: 'var(--eng-magenta)', stopOpacity: '0' })),
              h('pattern', { id: 'engGrid', width: 40, height: 40, patternUnits: 'userSpaceOnUse' }, h('path', { d: 'M40 0H0V40', fill: 'none', stroke: 'rgba(0, 240, 255, .08)', strokeWidth: 1 }))),
            h('rect', { x: 0, y: 0, width: 900, height: 620, fill: 'url(#engGrid)', opacity: 0.65 }),
            h('circle', { className: 'eng-graph-ring', cx: center.x, cy: center.y, r: 46, strokeWidth: 1 }),
            h('circle', { className: 'eng-graph-ring eng-graph-ring-2', cx: center.x, cy: center.y, r: 62, strokeWidth: 1 }),
            h('circle', { cx: center.x, cy: center.y, r: 74, fill: 'url(#engRootGlow)' }),
            h('circle', { cx: center.x, cy: center.y, r: 26, fill: 'rgba(0, 240, 255, .10)', stroke: 'var(--eng-cyan)', strokeWidth: 1.4, style: { filter: 'drop-shadow(0 0 8px rgba(0,240,255,.6))' } }),
            h('text', { x: center.x, y: center.y + 4, textAnchor: 'middle', className: 'eng-graph-label', style: { fontSize: 11, fontWeight: 650 } }, '经验库'),
            (data.edges || []).map((edge, index) => {
              const path = pathOf(edge)
              if (!path) return null
              return h('path', { key: `e${index}`, d: path, className: `eng-graph-edge${edge.kind === 'derived' ? ' eng-graph-edge-derived' : ''}`, strokeWidth: edge.kind === 'derived' ? 1.4 : 0.9, opacity: edge.kind === 'derived' ? 0.8 : 0.55, style: edge.kind === 'derived' ? { stroke: 'var(--eng-magenta)' } : edge.kind === 'root' ? { stroke: 'rgba(255, 43, 214, .30)' } : { stroke: 'rgba(0, 240, 255, .32)' } })
            }),
            nodes.map((node) => {
              const point = pos.get(node.id)
              if (!point) return null
              const color = colorOf(node)
              const isActive = active === node.id
              if (node.kind === 'type') {
                const radius = 12 + Math.min(9, Number(node.count) || 0)
                return h('g', { key: node.id, className: 'eng-graph-node', style: { color }, onClick: () => setActive(node.id), transform: `translate(${point.x},${point.y})` },
                  h('circle', { r: radius + 5, fill: color, opacity: 0.12 }),
                  h('circle', { r: radius, fill: 'rgba(4, 8, 16, .92)', stroke: color, strokeWidth: isActive ? 2.4 : 1.4, style: { filter: 'drop-shadow(0 0 10px currentColor)' } }),
                  h('text', { y: radius + 13, textAnchor: 'middle', className: 'eng-graph-label' }, node.label))
              }
              if (node.kind === 'skill') {
                return h('g', { key: node.id, className: 'eng-graph-node', style: { color }, onClick: () => setActive(node.id), transform: `translate(${point.x},${point.y})` },
                  h('rect', { x: -7, y: -7, width: 14, height: 14, rx: 3, transform: 'rotate(45)', fill: color, opacity: isActive ? 1 : 0.9 }),
                  h('text', { y: 23, textAnchor: 'middle', className: 'eng-graph-label' }, node.label))
              }
              const radius = 4.5 + Math.min(2.5, Math.abs(Number(node.G) || 0) * 2)
              return h('g', { key: node.id, className: 'eng-graph-node', style: { color }, onClick: () => setActive(node.id), transform: `translate(${point.x},${point.y})` },
                h('circle', { r: isActive ? radius + 3 : radius, fill: color, stroke: '#03050b', strokeWidth: 1, style: { filter: 'drop-shadow(0 0 8px currentColor)' } }),
                isActive ? h('text', { y: -10, textAnchor: 'middle', className: 'eng-graph-label' }, node.label) : null)
            })),
          h('div', { className: 'eng-graph-legend' },
            [['成功', '#39ff88'], ['部分', '#ffd166'], ['失败', '#ff3b5c'], ['未标', '#6c7a99']].map(([label, color]) => h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h('i', { style: { width: 8, height: 8, borderRadius: 99, background: color, display: 'inline-block' } }), label)),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h('i', { style: { width: 8, height: 8, background: '#ff2bd6', transform: 'rotate(45deg)', display: 'inline-block' } }), '技能'))),
        selected === null
          ? h('div', { className: 'eng-muted' }, '点击节点查看详情；虚线表示技能由哪些经验沉淀而来。')
          : h('div', { className: 'eng-card eng-detail' },
              h('div', { className: 'eng-actions', style: { marginBottom: 6 } }, h(Badge, { tone: selected.kind === 'skill' ? 'warn' : selected.kind === 'type' ? 'brand' : outcomeOf(selected.outcome)[1] }, selected.kind === 'type' ? '类型' : selected.kind === 'skill' ? '技能' : '经验')),
              h('h3', { className: 'eng-detail-title' }, selected.label || selected.id),
              h('dl', { className: 'eng-kv' },
                selected.kind === 'type' ? h('dt', null, '经验数') : null,
                selected.kind === 'type' ? h('dd', null, String(selected.count || 0)) : null,
                selected.kind === 'skill' ? h('dt', null, '使用') : null,
                selected.kind === 'skill' ? h('dd', null, `uses ${selected.uses || 0} · helped ${selected.helped || 0} · hurt ${selected.hurt || 0}`) : null,
                selected.kind === 'experience' ? h('dt', null, '结果') : null,
                selected.kind === 'experience' ? h('dd', null, `${outcomeOf(selected.outcome)[0]} · G ${fmtNumber(selected.G)}`) : null,
                selected.kind === 'experience' ? h('dt', null, 'id') : null,
                selected.kind === 'experience' ? h('dd', { className: 'eng-mono' }, selected.id.replace(/^exp:/, '')) : null)))
    }

    function Settings(props) {
      const settings = useLoad(useCallback(() => request('/settings'), []))
      const validation = useLoad(useCallback(() => request('/validate'), []))
      const [rootInput, setRootInput] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [configDraft, setConfigDraft] = useState({})
      const [uiDraft, setUiDraft] = useState({})
      useEffect(() => {
        if (!settings.data) return
        setRootInput(settings.data.currentRoot || settings.data.dataDir || '')
        setConfigDraft(settings.data.config || {})
        setUiDraft(settings.data.ui || {})
      }, [settings.data])
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
            (field.values || []).map((option) => h('option', { key: option, value: option }, option)))
        } else if (field.type === 'number') {
          control = h('input', { className: 'eng-input', type: 'number', step: 'any', placeholder: '默认', value: value === undefined ? '' : String(value), onChange: (event) => update(field.key, event.target.value) })
        } else {
          control = h('input', { className: 'eng-input', placeholder: '默认', value: value === undefined ? '' : String(value), onChange: (event) => update(field.key, event.target.value) })
        }
        return h(Field, { key: field.key, label: field.label, hint: field.hint }, control)
      })
      if (settings.error) return h(Banner, { bad: true }, settings.error)
      const data = settings.data || {}
      const spec = data.spec || { config: [], ui: [] }
      return h('div', { className: 'eng-stack' },
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
            h('dt', null, '版本'), h('dd', null, data.version || '—'))),
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '数据源（界面）'),
          h('div', { className: 'eng-form-grid' }, renderFields(spec.ui, uiDraft, setUiDraft)),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy, onClick: () => post({ ui: uiDraft }) }, '保存数据源'))),
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '内核参数'),
          h('div', { className: 'eng-muted', style: { marginBottom: 10 } }, '保存后写入 settings.json；DSH 插件下次读取即用新值，语义参数可立即生效。'),
          h('div', { className: 'eng-form-grid' }, renderFields(spec.config, configDraft, setConfigDraft)),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy, onClick: () => post({ config: configDraft }) }, '保存内核参数'))),
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '技能校验'),
          validation.data && validation.data.problems && validation.data.problems.length > 0
            ? validation.data.problems.map((item) => h('div', { key: item.slug, className: 'eng-muted', style: { marginBottom: 6 } }, `${item.slug}：${item.problems.join('；')}`))
            : h('div', { className: 'eng-muted' }, '全部健康')))
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
      const loadState = useCallback(async () => {
        try {
          setState(await request('/state'))
          setError('')
        } catch (caught) {
          setError(caught.message || String(caught))
        }
      }, [])
      useEffect(() => { loadState() }, [loadState])
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
      const brandMark = primitives !== null && typeof primitives.IconChecklistOutlineRegular === 'function'
        ? h(primitives.IconChecklistOutlineRegular, { size: 18 })
        : h('span', { style: { fontSize: 15 } }, '≡')
      return h('div', { className: 'eng-app', ref: rootRef, style: fitHeight === null ? undefined : { height: `${fitHeight}px` } },
        h('aside', { className: 'eng-rail' },
          h('div', { className: 'eng-brand' },
            h('span', { className: 'eng-brand-mark' }, brandMark),
            h('div', null, h('div', { className: 'eng-brand-name' }, TITLE), h('div', { className: 'eng-brand-sub' }, 'ENG RAM'))),
          h('nav', { className: 'eng-nav' }, NAV.map(navButton)),
          h('div', { className: 'eng-rail-foot' },
            h('div', { className: 'eng-mono', style: { marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: state ? state.dataDir : '' }, state ? state.dataDir : '读取中…'),
            h('div', null, source ? source.label : '—'))),
        h('main', { className: 'eng-main' },
          h('header', { className: 'eng-top' },
            h('div', null, h('h1', { className: 'eng-title' }, TITLE), h('div', { className: 'eng-sub' }, '经验与技能的本地控制台')),
            h('div', { className: 'eng-top-right' },
              source ? h(Badge, { tone: source.mode === 'mock' ? 'warn' : 'ok' }, source.mode === 'mock' ? '示例数据' : `数据：${source.label}`) : null,
              state ? h('span', { className: 'eng-muted' }, `v${state.version}`) : null,
              h(Button, { small: true, onClick: loadState }, '刷新'))),
          h('div', { className: 'eng-content' },
            error ? h(Banner, { bad: true }, error) : null,
            state && state.notice ? h(Banner, null, state.notice) : null,
            h(PageBoundary, { key: tab }, content))))
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ensureStyles()
        const disposers = []
        function PanelGlyph(props) {
          const size = props && Number(props.size) > 0 ? Number(props.size) : 16
          if (primitives !== null && typeof primitives.IconChecklistOutlineRegular === 'function') return h(primitives.IconChecklistOutlineRegular, { size })
          const active = Boolean(props && props.active)
          return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: active ? 1.3 : 1.1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block' } },
            h('rect', { x: 1.75, y: 2.5, width: 12.5, height: 11, rx: 2 }),
            h('path', { d: 'M4.4 6.1 L5.7 7.4 L8.1 4.9' }),
            h('path', { d: 'M9.4 6.2 H12.1' }),
            h('path', { d: 'M4.4 9.6 L5.7 10.9 L8.1 8.4' }),
            h('path', { d: 'M9.4 9.7 H12.1' }))
        }
        function BundleCard() {
          return h('div', { className: 'eng-card', style: { padding: 16 } },
            h('div', { className: 'eng-brand-name' }, TITLE),
            h('div', { className: 'eng-muted', style: { margin: '6px 0 12px' } }, '经验与技能的本地控制台：记录、检索、沉淀、校验。'),
            h(Button, { kind: 'primary', onClick: () => ctx.layout.selectPanel(PANEL_ID) }, '打开经验库'))
        }
        try {
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: () => TITLE }, PanelGlyph)))
        } catch (error) { console.error('[engram] panellist registration failed', error) }
        try {
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Console)))
        } catch (error) { console.error('[engram] main panel registration failed', error) }
        try {
          disposers.push(ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, BundleCard)))
        } catch (error) { console.error('[engram] bundle card registration failed', error) }
        ctx.effect(() => () => {
          for (const dispose of disposers.reverse()) {
            try { dispose() } catch (error) { console.error('[engram] dispose failed', error) }
          }
        })
      },
    }
  },
})
