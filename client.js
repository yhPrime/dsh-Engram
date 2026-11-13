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
.eng-app {
  /* == 1. tokens（P1/S1）：只声明不引用，必须排在 .eng-app 最前 ==
     间距七档：4/8/12/16/20/24/32；不要再写 5/6/7/9/10/14/15/17/18px 当间距。 */
  --eng-s-1: 4px; --eng-s-2: 8px; --eng-s-3: 12px; --eng-s-4: 16px;
  --eng-s-5: 20px; --eng-s-6: 24px; --eng-s-7: 32px;
  /* 固定尺寸 */
  --eng-rail-w: 208px; --eng-detail-w: 360px; --eng-content-max: 1240px; --eng-top-h: 56px;
  --eng-btn-h: 30px; --eng-btn-h-sm: 26px; --eng-ctrl-h-sm: 26px; --eng-badge-h: 20px;
  --eng-chip-h: 24px; --eng-kbd-h: 18px; --eng-dot: 7px; --eng-icon: 16px; --eng-icon-sm: 14px;
  --eng-hairline: 1px;
  /* 字号/行高/字重 */
  --eng-fs-display: 26px; --eng-lh-display: 1.15;
  --eng-fs-h1: 16px; --eng-lh-h1: 1.35;
  --eng-fs-h2: 14px; --eng-lh-h2: 1.4;
  --eng-fs-body: 13px; --eng-lh-body: 1.5;
  --eng-fs-sm: 12px; --eng-lh-sm: 1.5;
  --eng-fs-micro: 11px; --eng-lh-micro: 1.45;
  --eng-fs-mono: 11px; --eng-lh-mono: 1.6;
  --eng-fw-normal: 400; --eng-fw-medium: 500; --eng-fw-strong: 600; --eng-fw-heavy: 650;
  /* 圆角 */
  --eng-r-1: 6px; --eng-r-2: 8px; --eng-r-3: 10px; --eng-r-4: 12px; --eng-r-5: 14px; --eng-r-full: 999px;
  /* 阴影：只有浮层用，卡片只用 1px 边框 */
  --eng-shadow-1: 0 8px 24px rgba(0, 0, 0, .12);
  --eng-shadow-2: 0 18px 48px rgba(0, 0, 0, .20);
  --eng-shadow-3: 0 6px 18px rgba(0, 0, 0, .10);
  /* 动效 */
  --eng-dur-1: 90ms; --eng-dur-2: 140ms; --eng-dur-3: 180ms; --eng-dur-4: 240ms;
  --eng-ease-standard: cubic-bezier(.2, 0, 0, 1);
  --eng-ease-emphasized: cubic-bezier(.16, 1, .3, 1);
  --eng-stagger: 12ms;
  /* 焦点环 */
  --eng-focus-w: 2px; --eng-focus-offset: 1px;
  /* 语义色：宿主 token 优先，插件色兜底；底色由前景色 color-mix 派生 */
  --eng-ok: #1f9d63; --eng-warn: #c08312; --eng-bad: #d24b45;
  --eng-tone-ok-fg: color-mix(in srgb, var(--dsw-alias-state-success-primary, var(--eng-ok)) 50%, var(--dsw-alias-label-primary));
  --eng-tone-ok-bg: color-mix(in srgb, var(--eng-tone-ok-fg) 14%, transparent);
  --eng-tone-warn-fg: color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--eng-warn)) 50%, var(--dsw-alias-label-primary));
  --eng-tone-warn-bg: color-mix(in srgb, var(--eng-tone-warn-fg) 14%, transparent);
  --eng-tone-bad-fg: color-mix(in srgb, var(--dsw-alias-state-error-primary, var(--eng-bad)) 50%, var(--dsw-alias-label-primary));
  --eng-tone-bad-bg: color-mix(in srgb, var(--eng-tone-bad-fg) 14%, transparent);
  /* 默认皮肤：白底 + DSH 蓝强调 + 灰点缀；链接 token 自带亮/暗两套值。 */
  --eng-accent: var(--dsw-alias-brand-primary, var(--dsw-alias-link, #4176e6));
  --eng-accent-text: color-mix(in srgb, var(--eng-accent) 75%, var(--dsw-alias-label-primary));
  --eng-accent-soft: color-mix(in srgb, var(--eng-accent) 12%, transparent);
  --eng-accent-fill: var(--dsw-alias-brand-primary, var(--dsw-alias-link, #4176e6));
  --eng-accent-strong: color-mix(in srgb, var(--eng-accent-fill) 80%, #000);
  --eng-tone-brand-fg: var(--eng-accent-text);
  --eng-tone-brand-bg: var(--eng-accent-soft);
  --eng-tone-muted-fg: var(--dsw-alias-label-secondary, currentColor);
  --eng-tone-muted-bg: color-mix(in srgb, var(--eng-tone-muted-fg) 12%, transparent);
  /* 主题自适应叠加色（浅色压暗、深色提亮） */
  --eng-ink-6: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  --eng-ink-8: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  --eng-ink-14: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
  --eng-hover: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8));
  --eng-zebra: color-mix(in srgb, var(--dsw-alias-label-secondary) 5%, transparent);
  /* 密度（默认舒适档；compact 覆盖块紧跟其后） */
  --eng-row-h: 36px; --eng-row-py: 8px; --eng-card-pad: var(--eng-s-4);
  --eng-ctrl-h: 32px; --eng-gap: var(--eng-s-4); --eng-block-gap: var(--eng-s-5);
  /* 主按钮文字色：JS 按强调色亮度覆写；默认白字（蓝底） */
  --eng-on-brand: #fff;
  /* 骨架屏 */
  --eng-skeleton-base: color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent);
  --eng-skeleton-hi: color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent);
  /* 布局硬约束与最终属性放最后 */
  display: flex; width: 100%; max-width: 100%; box-sizing: border-box;
  height: 100%; max-height: 100%; min-height: 0; overflow: hidden;
  container-type: inline-size; container-name: eng;
  background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  font: var(--eng-fs-body)/var(--eng-lh-body) ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.eng-app[data-density="comfortable"] { --eng-row-h: 36px; --eng-row-py: 8px; --eng-card-pad: var(--eng-s-4); --eng-ctrl-h: 32px; --eng-gap: var(--eng-s-4); --eng-block-gap: var(--eng-s-5); }
.eng-app[data-density="compact"] { --eng-row-h: 30px; --eng-row-py: 5px; --eng-card-pad: var(--eng-s-3); --eng-ctrl-h: 28px; --eng-gap: var(--eng-s-3); --eng-block-gap: var(--eng-s-4); }
.eng-rail { width: var(--eng-rail-w); flex: 0 0 var(--eng-rail-w); display: flex; flex-direction: column; gap: 3px; padding: var(--eng-s-4) var(--eng-s-3); overflow-y: auto; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-specific-sidebar-fill, color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, var(--dsw-alias-bg-layer-2))); }
.eng-brand { display: flex; align-items: center; gap: 8px; padding: 4px 8px 16px; }
.eng-brand-mark { width: 30px; height: 30px; border-radius: var(--eng-r-3); display: grid; place-items: center; color: var(--eng-accent-text); background: var(--eng-accent-soft); }
.eng-brand-name { font-size: var(--eng-fs-h2); font-weight: 650; letter-spacing: .2px; }
.eng-brand-sub { margin-top: 1px; font-size: var(--eng-fs-micro); letter-spacing: .16em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.eng-nav { display: flex; flex-direction: column; gap: 2px; }
.eng-nav-item { display: flex; align-items: center; gap: var(--eng-s-2); width: 100%; min-height: 32px; padding: var(--eng-s-1) var(--eng-s-3); border: 0; border-radius: var(--eng-r-2); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; text-align: left; cursor: pointer; }
.eng-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); color: var(--dsw-alias-label-primary); }
.eng-nav-item[data-active="true"] { background: var(--eng-accent-soft); color: var(--eng-accent-text); font-weight: 600; }
.eng-nav-item:focus-visible { outline: 2px solid var(--eng-accent-text); outline-offset: 1px; }
.eng-nav-count { margin-left: auto; font-size: var(--eng-fs-micro); opacity: .72; font-variant-numeric: tabular-nums; }
.eng-rail-foot { margin-top: auto; padding: var(--eng-s-3) var(--eng-s-3) 2px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: var(--eng-fs-micro); line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.eng-nav-group + .eng-nav-group { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); }
.eng-nav-group-label { padding: var(--eng-s-2) var(--eng-s-3) var(--eng-s-1); font-size: var(--eng-fs-micro); font-weight: var(--eng-fw-strong); letter-spacing: .08em; color: var(--dsw-alias-label-secondary); opacity: .8; }
.eng-nav-item { position: relative; }
.eng-nav-item[data-active="true"]::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 2px; border-radius: 2px; background: var(--eng-accent-text); }
.eng-main { flex: 1 1 auto; min-width: 0; width: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.eng-top { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: var(--eng-s-3); padding: var(--eng-s-3) var(--eng-s-6); border-bottom: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)) 86%, transparent); backdrop-filter: blur(10px); }
.eng-title { margin: 0; font-size: var(--eng-fs-h1); line-height: var(--eng-lh-h1); font-weight: var(--eng-fw-heavy); letter-spacing: .1px; }
.eng-sub { margin-top: 2px; font-size: var(--eng-fs-micro); color: var(--dsw-alias-label-secondary); }
.eng-top-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.eng-modal { animation: eng-modal-in var(--eng-dur-4) var(--eng-ease-emphasized); }
@keyframes eng-modal-in { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes eng-fade-in { from { opacity: 0; } to { opacity: 1; } }
.eng-modal-mask { animation: eng-fade-in var(--eng-dur-2) var(--eng-ease-standard); }
.eng-modal-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: var(--eng-s-5); background: rgba(0, 0, 0, .34); }
.eng-modal { width: min(660px, 100%); max-height: min(760px, 88vh); overflow: auto; padding: var(--eng-s-5); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-5); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)); box-shadow: var(--eng-shadow-2); }
.eng-modal-title { margin: 0 0 4px; font-size: var(--eng-fs-h2); font-weight: 650; }
.eng-progress-text { font-size: var(--eng-fs-body); line-height: 1.6; margin: 4px 0 8px; }
.eng-progress-track { height: 8px; border-radius: var(--eng-r-full); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.18)); overflow: hidden; }
.eng-progress-meta { margin: 4px 0 8px; font-size: var(--eng-fs-sm); opacity: 0.72; }
.eng-progress-list { max-height: 240px; overflow: auto; display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
.eng-progress-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: var(--eng-r-2); font-size: var(--eng-fs-sm); }
.eng-progress-item[data-state="running"] { background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.12)); }
.eng-progress-item[data-state="failed"] { outline: 1px solid var(--dsw-alias-state-error-primary, rgba(200,60,60,0.45)); }
.eng-progress-dot { width: 7px; height: 7px; border-radius: var(--eng-r-full); flex-shrink: 0; background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.45)); }
.eng-progress-item[data-state="running"] .eng-progress-dot { background: var(--eng-accent); }
.eng-progress-item[data-state="done"] .eng-progress-dot { background: var(--dsw-alias-state-success-primary, rgba(40,160,90,0.9)); }
.eng-progress-item[data-state="failed"] .eng-progress-dot { background: var(--dsw-alias-state-error-primary, rgba(200,60,60,0.9)); }
.eng-progress-name { flex: 0 1 auto; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eng-progress-state { flex-shrink: 0; opacity: 0.8; }
.eng-progress-tag { flex-shrink: 0; padding: 1px 4px; border-radius: var(--eng-r-full); font-size: var(--eng-fs-micro); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.14)); }
.eng-progress-tag-soft { opacity: 0.75; }
.eng-progress-error { flex-shrink: 0; font-size: var(--eng-fs-micro); }
.eng-session { margin-top: 8px; max-height: 260px; overflow: auto; display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: var(--eng-r-3); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.10)); }
.eng-session-msg { display: flex; gap: 8px; font-size: var(--eng-fs-sm); line-height: 1.5; }
.eng-session-role { flex: 0 0 64px; opacity: 0.7; text-align: right; }
.eng-session-text { flex: 1 1 auto; word-break: break-word; }
.eng-session-msg[data-role="system"] .eng-session-text { opacity: 0.75; }
.eng-session-msg[data-bad="true"] .eng-session-text { text-decoration: line-through; opacity: 0.8; }
.eng-progress-bar { height: 100%; border-radius: var(--eng-r-full); background: var(--eng-accent); transition: width 180ms ease; }
.eng-modal-warn { margin: 12px 0 12px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); font-size: var(--eng-fs-sm); line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.eng-modal-warn b { color: var(--dsw-alias-label-primary); font-weight: 620; }
.eng-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
/* P3 命令面板 / 快捷键表 / Toast / 页面入场 */
.eng-palette { width: min(560px, 100%); max-height: min(620px, 84vh); display: flex; flex-direction: column; gap: var(--eng-s-2); }
.eng-palette-input { height: 36px; font-size: var(--eng-fs-body); }
.eng-palette-list { display: flex; flex-direction: column; gap: 2px; max-height: 400px; overflow: auto; }
.eng-palette-item { display: flex; align-items: center; gap: var(--eng-s-3); padding: var(--eng-s-2) var(--eng-s-3); border: 0; border-radius: var(--eng-r-2); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.eng-palette-item[data-active="true"] { background: var(--eng-hover); }
.eng-palette-group { flex: 0 0 64px; font-size: var(--eng-fs-micro); color: var(--dsw-alias-label-secondary); }
.eng-palette-label { flex: 1 1 auto; }
.eng-palette-foot { display: flex; align-items: center; gap: var(--eng-s-2); padding-top: var(--eng-s-2); border-top: 1px solid var(--dsw-alias-border-l1); font-size: var(--eng-fs-micro); color: var(--dsw-alias-label-secondary); }
.eng-shortcut-list { display: flex; flex-direction: column; gap: var(--eng-s-2); max-height: 50vh; overflow: auto; }
.eng-shortcut-row { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: var(--eng-s-3); align-items: center; font-size: var(--eng-fs-sm); }
.eng-toast-host { position: fixed; right: var(--eng-s-4); bottom: var(--eng-s-4); z-index: 2147483000; display: flex; flex-direction: column; gap: var(--eng-s-2); pointer-events: none; }
.eng-toast { pointer-events: auto; padding: var(--eng-s-2) var(--eng-s-3); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)); box-shadow: var(--eng-shadow-1); font-size: var(--eng-fs-sm); animation: eng-toast-in var(--eng-dur-3) var(--eng-ease-emphasized); }
.eng-toast[data-tone="bad"] { border-color: color-mix(in srgb, var(--eng-tone-bad-fg) 45%, var(--dsw-alias-border-l1)); color: var(--eng-tone-bad-fg); }
.eng-toast[data-tone="ok"] { border-color: color-mix(in srgb, var(--eng-tone-ok-fg) 45%, var(--dsw-alias-border-l1)); color: var(--eng-tone-ok-fg); }
@keyframes eng-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes eng-page-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.eng-fill { animation: eng-page-in var(--eng-dur-3) var(--eng-ease-standard); }
.eng-git-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); font-size: var(--eng-fs-sm); }
/* 「添加技能」的拖拽落区：虚线框 + 中间提示，拖进来时高亮 */
.eng-dropzone { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; margin: 12px 0 12px; padding: 26px 16px; border: 1.5px dashed var(--dsw-alias-border-l2, var(--dsw-alias-border-l1)); border-radius: var(--eng-r-5); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent); text-align: center; cursor: pointer; transition: border-color .15s ease, background .15s ease; }
.eng-dropzone:hover { border-color: color-mix(in srgb, var(--eng-accent) 55%, var(--dsw-alias-border-l2, var(--dsw-alias-border-l1))); }
.eng-dropzone[data-dragging="true"] { border-color: var(--eng-accent); background: var(--eng-accent-soft); }
.eng-dropzone-title { font-size: var(--eng-fs-h2); font-weight: 650; letter-spacing: .2px; }
.eng-dropzone-sub { font-size: var(--eng-fs-sm); line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.eng-dropzone-actions { display: flex; align-items: center; gap: 8px; font-size: var(--eng-fs-sm); }
.eng-dropzone-link { padding: 0; border: 0; background: none; font: inherit; font-size: var(--eng-fs-sm); color: var(--eng-accent-text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.eng-dropzone-file { margin-top: 4px; padding: 3px 8px; border-radius: var(--eng-r-full); font-size: var(--eng-fs-sm); color: var(--dsw-alias-label-primary); background: var(--eng-accent-soft); }
.eng-fixed-target { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: var(--eng-fs-sm); }
.eng-fixed-target code { padding: 3px 8px; border-radius: var(--eng-r-1); background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-req { margin: 8px 0 0; padding-left: 16px; font-size: var(--eng-fs-sm); line-height: 1.9; color: var(--dsw-alias-label-secondary); }
.eng-content { flex: 1 1 auto; width: 100%; max-width: min(var(--eng-content-max), 100%); min-height: 0; margin: 0 auto; padding: clamp(var(--eng-s-3), 2.4vw, var(--eng-s-6)); overflow-y: auto; overflow-x: auto; }
.eng-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.eng-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
.eng-card { min-width: 0; border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, var(--dsw-alias-label-secondary) 30%); border-radius: var(--eng-r-4); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 1px 2px rgba(0,0,0,.03); }
.eng-kpi { display: flex; flex-direction: column; gap: var(--eng-s-1); padding: var(--eng-card-pad); }
.eng-kpi-label { font-size: var(--eng-fs-micro); letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.eng-kpi-value { font-size: var(--eng-fs-display); line-height: var(--eng-lh-display); font-weight: var(--eng-fw-heavy); letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.eng-kpi-unit { margin-left: 4px; font-size: var(--eng-fs-micro); font-weight: 400; color: var(--dsw-alias-label-secondary); }
.eng-section { margin-top: 16px; }
.eng-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.eng-section-title { margin: 0; font-size: var(--eng-fs-body); font-weight: 650; }
.eng-muted { color: var(--dsw-alias-label-secondary); font-size: var(--eng-fs-sm); }
.eng-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--eng-s-1); height: var(--eng-btn-h); padding: 0 var(--eng-s-3); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--eng-fs-sm); cursor: pointer; transition: background var(--eng-dur-1) var(--eng-ease-standard), border-color var(--eng-dur-1) var(--eng-ease-standard), transform var(--eng-dur-1) var(--eng-ease-standard); }
.eng-btn:active:not(:disabled) { transform: scale(.98); }
.eng-btn:hover { border-color: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, var(--dsw-alias-border-l1)); background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-btn:disabled { opacity: .45; cursor: not-allowed; }
.eng-btn-primary { border-color: transparent; background: var(--eng-accent-strong); color: var(--eng-on-brand); }
.eng-btn-primary:hover { background: color-mix(in srgb, var(--eng-accent-strong) 85%, #000); }
.eng-btn-danger { color: var(--eng-tone-bad-fg); }
.eng-btn-sm { height: var(--eng-btn-h-sm); padding: 0 var(--eng-s-2); font-size: var(--eng-fs-micro); }
.eng-input, .eng-select, .eng-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--eng-fs-sm); padding: var(--eng-s-1) var(--eng-s-2); min-height: var(--eng-ctrl-h); }
.eng-input:focus, .eng-select:focus, .eng-textarea:focus { outline: 2px solid var(--eng-accent-text); outline-offset: 0; border-color: var(--eng-accent-text); }
.eng-textarea { min-height: 84px; resize: vertical; line-height: 1.55; }
.eng-field { display: flex; flex-direction: column; gap: var(--eng-s-1); margin-bottom: var(--eng-s-3); }
.eng-label { font-size: var(--eng-fs-micro); font-weight: var(--eng-fw-strong); color: var(--dsw-alias-label-secondary); letter-spacing: .03em; }
.eng-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
.eng-record { display: flex; flex-direction: column; gap: var(--eng-s-4); padding: var(--eng-s-5); }
.eng-form-group { padding-top: var(--eng-s-3); border-top: 1px solid var(--dsw-alias-border-l1); }
.eng-record > .eng-form-group:first-of-type { padding-top: 0; border-top: 0; }
.eng-form-group-title { margin-bottom: var(--eng-s-2); font-size: var(--eng-fs-h2); font-weight: var(--eng-fw-strong); cursor: pointer; }
.eng-receipt { padding: var(--eng-s-3); border: 1px solid color-mix(in srgb, var(--eng-tone-ok-fg) 30%, var(--dsw-alias-border-l1)); border-radius: var(--eng-r-3); background: var(--eng-tone-ok-bg); }
.eng-receipt-title { margin-bottom: var(--eng-s-1); color: var(--eng-tone-ok-fg); font-weight: var(--eng-fw-strong); }
.eng-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eng-badge { display: inline-flex; align-items: center; gap: var(--eng-s-1); height: var(--eng-badge-h); padding: 0 var(--eng-s-2); border-radius: var(--eng-r-full); font-size: var(--eng-fs-micro); font-weight: var(--eng-fw-strong); white-space: nowrap; color: var(--eng-tone-muted-fg); background: var(--eng-tone-muted-bg); }
.eng-badge[data-tone="ok"] { color: var(--eng-tone-ok-fg); background: var(--eng-tone-ok-bg); }
.eng-badge[data-tone="warn"] { color: var(--eng-tone-warn-fg); background: var(--eng-tone-warn-bg); }
.eng-badge[data-tone="bad"] { color: var(--eng-tone-bad-fg); background: var(--eng-tone-bad-bg); }
.eng-badge[data-tone="brand"] { color: var(--eng-tone-brand-fg); background: var(--eng-tone-brand-bg); }
.eng-badge[data-tone="muted"] { color: var(--eng-tone-muted-fg); background: var(--eng-tone-muted-bg); }
.eng-list { display: flex; flex-direction: column; }
.eng-list > * { animation: eng-list-in var(--eng-dur-3) var(--eng-ease-standard) both; }
.eng-list > *:nth-child(1) { animation-delay: 0ms; }
.eng-list > *:nth-child(2) { animation-delay: var(--eng-stagger); }
.eng-list > *:nth-child(3) { animation-delay: calc(var(--eng-stagger) * 2); }
.eng-list > *:nth-child(4) { animation-delay: calc(var(--eng-stagger) * 3); }
.eng-list > *:nth-child(5) { animation-delay: calc(var(--eng-stagger) * 4); }
.eng-list > *:nth-child(6) { animation-delay: calc(var(--eng-stagger) * 5); }
.eng-list > *:nth-child(n+7) { animation-delay: calc(var(--eng-stagger) * 6); }
@keyframes eng-list-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.eng-row, .eng-table tbody tr { content-visibility: auto; contain-intrinsic-size: auto 36px; }
.eng-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 92px 96px; gap: var(--eng-s-3); align-items: center; min-height: var(--eng-row-h); padding: var(--eng-row-py) var(--eng-s-3); border-bottom: 1px solid var(--dsw-alias-border-l1); cursor: pointer; }
.eng-row:last-child { border-bottom: 0; }
.eng-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-row[data-on="true"] { background: var(--eng-accent-soft); }
.eng-row-main { min-width: 0; }
.eng-row-intent { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 560; }
.eng-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--eng-fs-micro); color: var(--dsw-alias-label-secondary); }
.eng-mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: var(--eng-fs-mono); font-variant-numeric: tabular-nums; }
.eng-table { width: 100%; border-collapse: collapse; font-size: var(--eng-fs-sm); }
.eng-table th { padding: 8px 8px; text-align: left; font-size: var(--eng-fs-micro); font-weight: 600; letter-spacing: .05em; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.eng-table td { padding: 8px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.eng-table tr:last-child td { border-bottom: 0; }
.eng-scroll .eng-table thead th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-1); }
.eng-tip { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: 4px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: var(--eng-fs-micro); font-weight: 600; line-height: 1; cursor: help; vertical-align: middle; }
.eng-tip:hover, .eng-tip:focus-visible { color: var(--eng-accent-text); border-color: var(--eng-accent); outline: none; }
/* 悬浮说明挂在 <body> 上（position: fixed）：宽度按视口上限收，左右上下再夹回视口内，
   不会被面板的 overflow 容器裁掉半截，也不会把长句子排出屏幕。 */
.eng-tip-layer { position: fixed; z-index: 2147483000; box-sizing: border-box; width: max-content; max-width: min(340px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow-y: auto; padding: 8px 8px; border-radius: var(--eng-r-2); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12)); background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-primary, #1f2329); font: 11px/1.55 ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; text-align: left; white-space: normal; word-break: break-word; overflow-wrap: anywhere; box-shadow: 0 8px 24px rgba(0,0,0,.2); pointer-events: none; }
.eng-subnav { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.eng-subnav-item { padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--eng-fs-sm); cursor: pointer; }
.eng-subnav-item:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); color: var(--dsw-alias-label-primary); }
.eng-subnav-item[data-active="true"] { border-color: transparent; background: var(--eng-accent-soft); color: var(--eng-accent-text); font-weight: 600; }.eng-git-repos { max-height: 240px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); margin-bottom: 8px; }
.eng-git-repo { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.eng-git-repo:last-child { border-bottom: 0; }.eng-empty { padding: var(--eng-s-7) var(--eng-s-4); text-align: center; color: var(--dsw-alias-label-secondary); font-size: var(--eng-fs-sm); }
.eng-banner { margin-bottom: 12px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent); color: var(--dsw-alias-label-secondary); font-size: var(--eng-fs-sm); }
.eng-banner-bad { border-color: color-mix(in srgb, var(--eng-bad) 40%, var(--dsw-alias-border-l1)); color: var(--eng-bad); }
.eng-detail { padding: var(--eng-s-4); animation: eng-detail-in var(--eng-dur-3) var(--eng-ease-standard); }
@keyframes eng-detail-in { from { opacity: 0; transform: translateX(6px); } to { opacity: 1; transform: translateX(0); } }
.eng-detail-title { font-size: var(--eng-fs-h2); font-weight: 650; margin: 0 0 4px; }
/* 技能详情上面的管理卡：两颗胶囊一行放这，详情卡在它下面 */
.eng-skill-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; }
.eng-kv { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 4px 8px; font-size: var(--eng-fs-sm); }
.eng-kv dt { color: var(--dsw-alias-label-secondary); }
.eng-kv dd { margin: 0; word-break: break-word; }
.eng-pre { margin: 0; padding: var(--eng-s-3); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: var(--dsw-alias-bg-layer-2); font-family: ui-monospace, Consolas, monospace; font-size: var(--eng-fs-mono); line-height: var(--eng-lh-mono); white-space: pre-wrap; word-break: break-word; }
.eng-chipbar { display: flex; gap: 4px; flex-wrap: wrap; }
.eng-chip { padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--eng-fs-micro); cursor: pointer; }
.eng-chip[data-on="true"] { border-color: transparent; background: var(--eng-accent-soft); color: var(--eng-accent-text); font-weight: 600; }
.eng-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.eng-toolbar .eng-input { width: min(220px, 100%); }
.eng-toolbar .eng-select { width: min(140px, 100%); }
.eng-pager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.eng-pager .eng-muted { margin-right: auto; }
.eng-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; align-items: start; }
.eng-stack { display: flex; flex-direction: column; gap: 12px; }
.eng-skill-row { padding: 8px 12px; display: flex; gap: 12px; align-items: center; cursor: pointer; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.eng-skill-row:last-child { border-bottom: 0; }
.eng-skill-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-skill-row[data-on="true"] { background: var(--eng-accent-soft); }
.eng-skill-name { font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eng-skill-desc { font-size: var(--eng-fs-sm); color: var(--dsw-alias-label-secondary); margin-top: 2px; }
/* 技能套件树：chevron 只负责展开/收起，行本身负责选中详情 */
.eng-tree-row { padding-top: 8px; padding-bottom: 8px; align-items: flex-start; }
.eng-tree-toggle { flex: 0 0 18px; width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--eng-fs-micro); line-height: 1; cursor: pointer; }
.eng-tree-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); color: var(--dsw-alias-label-primary); }
.eng-tree-toggle:focus-visible { outline: 2px solid var(--eng-accent-text); outline-offset: 1px; }
.eng-suite-tag { display: inline-flex; align-items: center; height: 18px; margin-left: 8px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--eng-fs-micro); font-weight: 500; cursor: pointer; vertical-align: middle; }
.eng-suite-tag:hover { border-color: var(--eng-accent); color: var(--eng-accent-text); }
.eng-suite-tag[data-static="true"] { cursor: default; }
.eng-crumb { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 4px; font-size: var(--eng-fs-micro); color: var(--dsw-alias-label-secondary); }
.eng-crumb button { padding: 0; border: 0; background: none; color: var(--eng-accent-text); font: inherit; font-size: var(--eng-fs-micro); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.eng-crumb button:hover { color: var(--dsw-alias-label-primary); }
.eng-crumb-sep { opacity: .5; }
.eng-nav-sep { height: 1px; margin: 8px 8px; background: var(--dsw-alias-border-l1); }
@container (max-width: 980px) { .eng-cols, .eng-split { grid-template-columns: minmax(0, 1fr); } .eng-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .eng-split[data-open="true"] > .eng-detail-card { order: -1; } }
@container (max-width: 680px) { .eng-rail { width: 100%; flex: 0 0 auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 8px 12px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); overflow: visible; } .eng-brand { padding: 0 8px 0 2px; } .eng-brand-sub { display: none; } .eng-nav { flex-direction: row; flex-wrap: wrap; } .eng-nav-item { width: auto; padding: 4px 8px; } .eng-nav-count, .eng-rail-foot, .eng-nav-sep { display: none; } .eng-content { padding: 12px; } .eng-top { padding: 8px 12px; } .eng-form-grid { grid-template-columns: minmax(0, 1fr); } .eng-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 1180px) { .eng-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .eng-cols, .eng-split { grid-template-columns: minmax(0, 1fr); } .eng-split[data-open="true"] > .eng-detail-card { order: -1; } }
@media (max-width: 860px) { .eng-app { flex-direction: column; } .eng-rail { width: 100%; flex: 0 0 auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 8px 12px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); } .eng-brand { padding: 0 8px 0 2px; } .eng-brand-sub { display: none; } .eng-nav { flex-direction: row; flex-wrap: wrap; } .eng-nav-item { width: auto; padding: 4px 8px; } .eng-nav-count, .eng-rail-foot, .eng-nav-sep { display: none; } .eng-content { padding: 12px; } .eng-top { padding: 8px 12px; } .eng-form-grid { grid-template-columns: minmax(0, 1fr); } }
/* 选中技能时详情卡置顶；管理卡再压它上面（order -2 < -1）。
   注意：这两条是全局的——之前只给详情 -1、没管管理卡，管理卡就掉到详情下面去了。 */
.eng-split[data-open="true"] .eng-stack > .eng-skill-actions { order: -2; }
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
.eng-graph-canvas-wrap { position: relative; width: 100%; aspect-ratio: 16 / 9; min-height: 420px; overflow: hidden; border-radius: var(--eng-r-4); background: transparent; }
.eng-graph-canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; user-select: none; }
.eng-graph-fullscreen { position: absolute; top: 14px; right: 14px; z-index: 6; width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.10); }
.eng-graph-fullscreen:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-graph-fullscreen:focus-visible { outline: 2px solid var(--eng-accent-text); outline-offset: 2px; }
.eng-graph-canvas-wrap:fullscreen { width: 100vw; height: 100vh; aspect-ratio: auto; border-radius: 0; background: var(--dsw-alias-bg-base); }
.eng-graph-canvas-wrap:fullscreen .eng-graph-fullscreen { top: 18px; right: 18px; }
.eng-content-full { padding: 0; max-width: none; overflow: hidden; display: flex; }
.eng-content-full .eng-graph-canvas-wrap { flex: 1 1 auto; height: 100%; min-height: 0; aspect-ratio: auto; border-radius: 0; }
.eng-graph-detail { position: absolute; right: 14px; bottom: 14px; z-index: 2; width: min(320px, 72%); padding: 12px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent); backdrop-filter: blur(10px); box-shadow: 0 10px 30px rgba(0,0,0,.14); }
.eng-graph-detail-title { font-size: var(--eng-fs-body); font-weight: 650; margin: 0 0 4px; word-break: break-word; }
.eng-graph-detail-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
/* 关系图右上角配色胶囊：跟随主题 / 蓝紫星辰（dsh-codex-effort-slider 的渐变） */
.eng-graph-pill { position: absolute; top: 14px; right: 14px; z-index: 3; display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent); backdrop-filter: blur(10px); box-shadow: 0 6px 18px rgba(0,0,0,.10); }
.eng-graph-pill button { border: 0; border-radius: var(--eng-r-full); padding: 4px 12px; font: inherit; font-size: var(--eng-fs-sm); line-height: 1.2; color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer; white-space: nowrap; }
.eng-graph-pill button:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-graph-pill button[data-active="true"] { color: #fff; background: var(--eng-accent-strong); }
.eng-graph-pill button[data-tone="codex"][data-active="true"] { background: linear-gradient(90deg, #4d93f8 0%, #6d28d9 42%, #9333ea 74%, #c084fc 100%); }
/* 左下角：画布深浅背景切换（与右上角配色胶囊同一套皮肤） */
.eng-graph-pill-bottom { top: auto; right: auto; bottom: 14px; left: 14px; }
.eng-graph-pill-top { top: 14px; right: auto; left: 14px; }
.eng-graph-note { position: absolute; right: 14px; bottom: 14px; z-index: 3; display: flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent); color: var(--dsw-alias-label-secondary); font-size: var(--eng-fs-sm); backdrop-filter: blur(10px); }
.eng-graph-note-btn { padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); font: inherit; font-size: var(--eng-fs-micro); color: var(--eng-accent-text); background: var(--dsw-alias-bg-layer-1); cursor: pointer; }
.eng-graph-note-btn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-graph-drawer-toggle { position: absolute; top: 14px; left: 14px; z-index: 6; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--eng-fs-sm); cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.10); }
.eng-graph-drawer-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-graph-drawer { position: absolute; top: 56px; left: 14px; z-index: 6; width: min(330px, calc(100% - 28px)); max-height: calc(100% - 78px); overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 16px 40px rgba(0,0,0,.22); }
.eng-graph-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.eng-graph-drawer-close { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); padding: 2px 9px; font: inherit; font-size: var(--eng-fs-micro); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); cursor: pointer; }
.eng-graph-drawer-label { margin-top: 4px; font-size: var(--eng-fs-micro); font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .04em; }
.eng-graph-drawer .eng-graph-search { position: static; width: 100%; padding: 0; }
.eng-graph-drawer .eng-graph-filters button { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.eng-graph-drawer .eng-graph-filters button[data-active="true"] { color: var(--eng-accent-text); border-color: var(--eng-accent); background: var(--eng-accent-soft); }
.eng-graph-legend-inline { display: flex; flex-direction: column; gap: var(--eng-s-1); max-height: 180px; overflow: auto; }
.eng-graph-search { position: absolute; left: 14px; top: 58px; z-index: 4; width: min(320px, 72%); display: flex; flex-direction: column; gap: 6px; }
.eng-graph-search-input { width: 100%; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent); backdrop-filter: blur(10px); }
.eng-graph-search-hits { display: flex; flex-direction: column; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)); box-shadow: var(--eng-shadow-1); }
.eng-graph-search-hit { border: 0; border-radius: var(--eng-r-2); padding: 5px 8px; font: inherit; font-size: var(--eng-fs-sm); text-align: left; color: var(--dsw-alias-label-primary); background: transparent; cursor: pointer; }
.eng-graph-search-hit:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-graph-filters { display: flex; flex-wrap: wrap; gap: 4px; }
.eng-graph-filters button { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-full); padding: 2px 9px; font: inherit; font-size: var(--eng-fs-micro); color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent); cursor: pointer; }
.eng-graph-filters button[data-active="true"] { color: var(--eng-accent-text); border-color: var(--eng-accent); background: var(--eng-accent-soft); }
.eng-visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
.eng-graph-legend { position: absolute; left: 14px; top: 178px; z-index: 3; width: min(300px, 72%); display: flex; flex-direction: column; gap: var(--eng-s-2); padding: var(--eng-s-3); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--eng-r-3); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)); box-shadow: var(--eng-shadow-1); }
.eng-graph-legend-list { display: flex; flex-direction: column; gap: var(--eng-s-1); max-height: 200px; overflow: auto; }
.eng-graph-legend-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) 40px; gap: var(--eng-s-2); align-items: center; font-size: var(--eng-fs-sm); }
.eng-graph-legend-btn { display: grid; grid-template-columns: 10px minmax(0, 1fr) 40px; gap: var(--eng-s-2); align-items: center; width: 100%; padding: 2px 6px; border: 1px solid transparent; border-radius: var(--eng-r-2); font: inherit; font-size: var(--eng-fs-sm); color: inherit; text-align: left; background: transparent; cursor: pointer; }
.eng-graph-legend-btn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8)); }
.eng-graph-legend-btn[data-active="true"] { color: var(--eng-accent-text); border-color: var(--eng-accent); background: var(--eng-accent-soft); }
.eng-legend-dot { width: 7px; height: 7px; border-radius: var(--eng-r-full); background: var(--eng-accent); }
.eng-graph-pill button[data-tone="light"] { color: #1f2430; }
.eng-graph-pill button[data-tone="light"][data-active="true"] { color: #1f2430; background: #eef1f6; }
.eng-graph-pill button[data-tone="dark"][data-active="true"] { color: #f4f6fb; background: #171b28; }
.eng-warn-text { color: var(--eng-tone-warn-fg); }
.eng-bad-text { color: var(--eng-tone-bad-fg); }
/* P2 概览：7 日柱条 / 类型分布 / 存储格 / 待判定 */
.eng-spark { display: flex; align-items: flex-end; gap: var(--eng-s-1); height: 52px; padding-top: var(--eng-s-2); }
.eng-spark-col { flex: 1 1 0; display: flex; align-items: flex-end; height: 100%; min-width: 6px; }
.eng-spark-bar { width: 100%; min-height: 2px; border-radius: var(--eng-r-1) var(--eng-r-1) 0 0; background: color-mix(in srgb, var(--eng-accent) 55%, transparent); }
.eng-dist { display: flex; flex-direction: column; gap: var(--eng-s-2); }
.eng-dist-row { display: grid; grid-template-columns: 110px minmax(0, 1fr) 40px; gap: var(--eng-s-2); align-items: center; font-size: var(--eng-fs-sm); }
.eng-dist-track { height: 6px; border-radius: var(--eng-r-full); background: var(--eng-ink-8); overflow: hidden; }
.eng-dist-fill { height: 100%; border-radius: inherit; background: var(--eng-accent); }
.eng-section-card { padding: var(--eng-card-pad); }
.eng-section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--eng-s-2); margin-bottom: var(--eng-s-2); }
.eng-section-head-pad { padding: var(--eng-s-3) var(--eng-s-3) var(--eng-s-1); margin-bottom: 0; }
.eng-section-note { margin-top: var(--eng-s-2); }
.eng-storage-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--eng-s-3); }
@container eng (max-width: 680px) { .eng-storage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.eng-stat-main { margin-top: var(--eng-s-1); font-size: var(--eng-fs-h2); font-weight: var(--eng-fw-strong); line-height: var(--eng-lh-h2); }
.eng-subsection { margin-top: var(--eng-s-3); padding-top: var(--eng-s-2); border-top: 1px solid var(--dsw-alias-border-l1); }
.eng-subsection-head { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: var(--eng-s-1) 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.eng-subsection-body { margin-top: var(--eng-s-2); display: flex; flex-direction: column; gap: var(--eng-s-1); }
.eng-cold-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--eng-s-2); align-items: center; font-size: var(--eng-fs-sm); }
.eng-strong { font-weight: var(--eng-fw-strong); }
.eng-row-button { width: 100%; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: transparent; color: inherit; font: inherit; text-align: left; }
.eng-pending-row { display: flex; align-items: center; gap: var(--eng-s-2); }
.eng-tabs { display: flex; gap: var(--eng-s-1); margin: var(--eng-s-3) 0 var(--eng-s-2); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.eng-tab { padding: var(--eng-s-1) var(--eng-s-2); border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--eng-fs-sm); cursor: pointer; }
.eng-tab[data-active="true"] { color: var(--eng-accent-text); border-bottom-color: var(--eng-accent-text); font-weight: var(--eng-fw-strong); }
.eng-tab-body { min-height: 120px; }
.eng-timeline { display: flex; flex-direction: column; gap: var(--eng-s-2); }
.eng-timeline-item { display: grid; grid-template-columns: 120px 90px minmax(0, 1fr); gap: var(--eng-s-2); align-items: center; font-size: var(--eng-fs-sm); }
.eng-note { margin-top: var(--eng-s-3); display: flex; flex-direction: column; gap: var(--eng-s-1); }
.eng-pre-json { max-height: 320px; overflow: auto; }
.eng-detail-actions { margin-top: var(--eng-s-4); }
/* 骨架 / 错误态 / Kbd（P1：S3 组件 + S7 三态） */
.eng-skeleton { display: flex; flex-direction: column; gap: var(--eng-s-2); padding: var(--eng-s-3); }
.eng-skeleton-row { height: 10px; border-radius: var(--eng-r-1); background: linear-gradient(90deg, var(--eng-skeleton-base) 0%, var(--eng-skeleton-hi) 50%, var(--eng-skeleton-base) 100%); background-size: 200% 100%; animation: eng-shimmer 1.2s linear infinite; }
@keyframes eng-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.eng-error-state { display: flex; flex-direction: column; align-items: flex-start; gap: var(--eng-s-2); padding: var(--eng-s-4); border: 1px solid color-mix(in srgb, var(--eng-tone-bad-fg) 35%, var(--dsw-alias-border-l1)); border-radius: var(--eng-r-3); background: var(--eng-tone-bad-bg); }
.eng-error-title { font-weight: var(--eng-fw-strong); color: var(--eng-tone-bad-fg); }
.eng-kbd { display: inline-flex; align-items: center; height: var(--eng-kbd-h); padding: 0 var(--eng-s-1); border: 1px solid var(--dsw-alias-border-l1); border-bottom-width: 2px; border-radius: var(--eng-r-1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: var(--eng-fs-micro); font-family: inherit; }
/* 焦点环：键盘可见，鼠标不打扰 */
.eng-btn:focus-visible, .eng-row:focus-visible, .eng-skill-row:focus-visible, .eng-chip:focus-visible, .eng-input:focus-visible, .eng-select:focus-visible, .eng-textarea:focus-visible { outline: var(--eng-focus-w) solid var(--eng-accent-text); outline-offset: var(--eng-focus-offset); }
/* 系统减弱动效：无位移、无 shimmer、无缩放（放在 PANEL_CSS 最后） */
@media (prefers-reduced-motion: reduce) {
  .eng-app *, .eng-app *::before, .eng-app *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }
  .eng-btn:active:not(:disabled) { transform: none; }
}
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

    const TONES = { ok: true, warn: true, bad: true, muted: true, brand: true }

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
    /** 主题强调色：默认皮肤的品牌色是黑白（中性），此时退回 DSH 蓝；有彩色主题则跟随主题。 */
    function pickAccent(rgb, dark = false) {
      const fallback = dark ? '#5686fe' : '#4176e6'
      if (!Array.isArray(rgb) || rgb.length < 3) return fallback
      const [r, g, b] = rgb.map((value) => Number(value))
      if (![r, g, b].every((value) => Number.isFinite(value))) return fallback
      const chroma = Math.max(r, g, b) - Math.min(r, g, b)
      // 默认主题 brand-primary 是 #0f1115 / #f9fafb，chroma 只有个位数；彩色主题远高于 16。
      if (chroma < 16) return fallback
      return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`
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

    /* ------------------------------------------------------------------
     * 技能套件树：路径 id、展开状态、面包屑/互链的纯函数。
     * 服务端 `/skills` 的 tree 是权威；旧响应没有 tree 时用平铺 rows 兜底，
     * 保证单技能 / 老内核下页面照常可用。
     * ------------------------------------------------------------------ */
    const SUITE_OPEN_KEY = 'eng-suite-open'

    function suiteStore() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) return localStorage
      } catch {
        // 隐私模式 / 测试环境：忽略
      }
      try {
        if (typeof window !== 'undefined' && window !== null && window.localStorage) return window.localStorage
      } catch {
        // 同上
      }
      return null
    }

    /** 展开状态：只记「开着的 path」，默认全收起。 */
    function readSuiteOpen() {
      try {
        const store = suiteStore()
        const raw = store === null ? '' : store.getItem(SUITE_OPEN_KEY)
        if (raw === null || raw === '') return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false ? parsed : {}
      } catch {
        return {}
      }
    }

    function writeSuiteOpen(map) {
      try {
        const store = suiteStore()
        if (store !== null) store.setItem(SUITE_OPEN_KEY, JSON.stringify(map || {}))
      } catch {
        // 存不了就只影响刷新后的展开状态，不影响本次操作
      }
    }

    function pathSegmentsOf(value) {
      return String(value === undefined || value === null ? '' : value).split('/').filter((segment) => segment !== '')
    }

    function lastSegmentOf(value) {
      const segments = pathSegmentsOf(value)
      return segments.length === 0 ? String(value || '') : segments[segments.length - 1]
    }

    function rootNameOf(value) {
      const segments = pathSegmentsOf(value)
      return segments.length === 0 ? '' : segments[0]
    }

    /** 技能行的相对路径 id：优先 `path`，但老 live 行的 path 是绝对目录，退回 `id`。 */
    function relativePathOf(row) {
      if (row === null || row === undefined) return ''
      const raw = typeof row.path === 'string' ? row.path.trim() : ''
      const looksRelative = raw !== '' && raw.includes('\\') === false && raw.startsWith('/') === false && /^[A-Za-z]:/u.test(raw) === false
      if (looksRelative) return raw
      return String(row.id || '')
    }

    function treeNodeAt(nodes, path) {
      if (Array.isArray(nodes) === false || typeof path !== 'string' || path === '') return null
      for (const node of nodes) {
        if (node === null || node === undefined) continue
        if (node.path === path) return node
        const found = treeNodeAt(nodeChildrenOf(node), path)
        if (found !== null) return found
      }
      return null
    }

    function nodeChildrenOf(node) {
      return node !== null && node !== undefined && Array.isArray(node.children) ? node.children.filter((child) => child !== null && child !== undefined) : []
    }

    function nodeSkillCountOf(node) {
      if (node === null || node === undefined) return 0
      const declared = Number(node.skillCount)
      if (Number.isFinite(declared) && declared > 0) return Math.trunc(declared)
      let total = node.kind === 'group' ? 0 : 1
      for (const child of nodeChildrenOf(node)) total += nodeSkillCountOf(child)
      return total
    }

    function nodeDepthOf(node) {
      const depth = Number(node && node.depth)
      return Number.isFinite(depth) && depth > 0 ? Math.trunc(depth) : 0
    }

    function prefixPathsOf(path) {
      const segments = pathSegmentsOf(path)
      return segments.map((segment, index) => segments.slice(0, index + 1).join('/'))
    }

    /** 从平铺 rows 兜底出一层树（旧响应 / 单技能）。 */
    function normalizeSkillTree(data) {
      const rows = data !== null && data !== undefined && Array.isArray(data.skills) ? data.skills : []
      const given = data !== null && data !== undefined && Array.isArray(data.tree) ? data.tree.filter((node) => node !== null && node !== undefined && typeof node.path === 'string' && node.path !== '') : []
      if (given.length > 0) return given
      const tree = []
      for (const row of rows) {
        const path = relativePathOf(row)
        if (path === '') continue
        tree.push({
          path,
          name: row.name || lastSegmentOf(path),
          kind: row.kind === 'group' ? 'group' : 'skill',
          depth: Number(row.depth) || 0,
          skillCount: Number(row.skillCount) || 1,
          registeredCount: row.globalRegistered ? 1 : 0,
          children: [],
        })
      }
      return tree
    }

    /** 子技能标签/面包屑要跳回的套件节点：优先顶层根，找不到就退到最近的已存在祖先。 */
    function suitePathOf(tree, path) {
      const prefixes = prefixPathsOf(path)
      if (prefixes.length <= 1) return ''
      const top = prefixes[0]
      if (treeNodeAt(tree, top) !== null) return top
      for (let index = prefixes.length - 2; index >= 0; index -= 1) {
        if (treeNodeAt(tree, prefixes[index]) !== null) return prefixes[index]
      }
      return ''
    }

    function rowAtPath(rows, path) {
      if (Array.isArray(rows) === false) return null
      return rows.find((row) => relativePathOf(row) === path) || null
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
      const tone = Object.prototype.hasOwnProperty.call(TONES, props.tone) ? props.tone : 'muted'
      return h('span', { className: 'eng-badge', 'data-tone': tone }, props.children)
    }
    function Button(props) {
      const kind = props.kind === 'primary' ? 'eng-btn eng-btn-primary' : props.kind === 'danger' ? 'eng-btn eng-btn-danger' : 'eng-btn'
      return h('button', { type: 'button', className: `${kind}${props.small ? ' eng-btn-sm' : ''}`, disabled: props.disabled, onClick: props.onClick, title: props.title }, props.children)
    }
    /**
     * 悬浮说明层：挂在 <body> 下、`position: fixed` 定位。
     * 以前气泡是 `.eng-tip` 里的绝对定位子元素，面板一窄 / 一滚动就被 overflow 容器裁掉半截
     * （提示只露中间几行）。现在宽度按视口收（max-width 见 .eng-tip-layer），
     * 位置算完再左右、上下夹回视口，长句子也一定读得全。
     */
    const TIP_LAYER_CLASS = 'eng-tip-layer'
    let tipLayerBound = false
    function hideTipLayer() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      const nodes = document.querySelectorAll(`.${TIP_LAYER_CLASS}`)
      for (const node of Array.from(nodes)) {
        if (!node) continue
        if (typeof node.remove === 'function') node.remove()
        else if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node)
      }
    }
    function showTipLayer(text, anchor) {
      hideTipLayer()
      if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return
      if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return
      const rect = anchor.getBoundingClientRect()
      const win = typeof window === 'undefined' ? {} : window
      const layer = document.createElement('div')
      layer.className = TIP_LAYER_CLASS
      layer.setAttribute('role', 'tooltip')
      layer.textContent = text
      document.body.appendChild(layer)
      // 说明层在 <body> 下，拿不到面板里那层宿主 alias 变量；从锚点算出来的值抄过来，
      // 浅色/深色主题气泡都跟着面板走（抄不到就用 CSS 里的兜底色）。
      const readStyle = win.getComputedStyle || (document.defaultView && document.defaultView.getComputedStyle)
      if (typeof readStyle === 'function') {
        let styles = null
        try {
          styles = readStyle.call(win, anchor)
        } catch {
          styles = null
        }
        if (styles && typeof styles.getPropertyValue === 'function') {
          const background = String(styles.getPropertyValue('--dsw-alias-bg-layer-2') || '').trim()
          const foreground = String(styles.getPropertyValue('--dsw-alias-label-primary') || '').trim()
          const borderColor = String(styles.getPropertyValue('--dsw-alias-border-l1') || '').trim()
          if (background !== '') layer.style.background = background
          if (foreground !== '') layer.style.color = foreground
          if (borderColor !== '') layer.style.borderColor = borderColor
        }
      }
      const width = Number(layer.offsetWidth) || 0
      const height = Number(layer.offsetHeight) || 0
      const root = document.documentElement || {}
      const viewportWidth = Number(root.clientWidth) || Number(win.innerWidth) || 1024
      const viewportHeight = Number(root.clientHeight) || Number(win.innerHeight) || 768
      const margin = 8
      const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, viewportWidth - width - margin))
      let top = rect.top - height - margin
      if (top < margin) top = Math.min(rect.bottom + margin, viewportHeight - height - margin)
      top = Math.max(margin, top)
      layer.style.left = `${Math.round(left)}px`
      layer.style.top = `${Math.round(top)}px`
      if (!tipLayerBound && typeof win.addEventListener === 'function') {
        tipLayerBound = true
        // 面板一滚/一缩放，固定坐标就失效了：直接收起来，别留一个漂着的说明。
        win.addEventListener('scroll', hideTipLayer, true)
        win.addEventListener('resize', hideTipLayer)
      }
    }
    /** 悬浮说明：问号图标，悬停/键盘聚焦时弹气泡（用于有歧义的设置项）。 */
    function Tip(props) {
      const text = String(props.text || '')
      useEffect(() => hideTipLayer, [])
      if (text === '') return null
      return h('span', {
        className: 'eng-tip',
        tabIndex: 0,
        role: 'note',
        'aria-label': text,
        onMouseEnter: (event) => showTipLayer(text, event.currentTarget),
        onFocus: (event) => showTipLayer(text, event.currentTarget),
        onMouseLeave: hideTipLayer,
        onBlur: hideTipLayer,
      }, '?')
    }
    let fieldSeq = 0
    function Field(props) {
      const idRef = useRef(null)
      if (idRef.current === null) {
        fieldSeq += 1
        idRef.current = `eng-field-${fieldSeq}`
      }
      const fieldId = idRef.current
      const child = props.children
      const linked = child !== null && typeof child === 'object' && !Array.isArray(child)
        ? { ...child, props: { ...(child.props || {}), id: (child.props && child.props.id) || fieldId } }
        : child
      return h('div', { className: 'eng-field', style: props.wide ? { gridColumn: '1 / -1' } : undefined },
        props.label ? h('label', { className: 'eng-label', htmlFor: fieldId }, props.label, props.tip ? h(Tip, { text: props.tip }) : null) : null,
        linked,
        props.hint ? h('span', { className: 'eng-muted' }, props.hint) : null)
    }
    function Empty(props) {
      return h('div', { className: 'eng-empty' }, props.children || '暂无数据')
    }
    /** 加载骨架：只在 >250ms 的等待里显示（调用方控制），不挡读屏。 */
    function Skeleton(props) {
      const rows = Math.max(1, Math.min(8, Number(props && props.rows) || 3))
      return h('div', { className: 'eng-skeleton', 'aria-hidden': 'true' },
        Array.from({ length: rows }).map((_, index) => h('div', { key: index, className: 'eng-skeleton-row', style: { width: `${Math.max(40, 100 - index * 8)}%` } })))
    }
    /** 错误态：标题 + 原因 + 重试；比一行 Banner 更适合整块内容读取失败。 */
    function ErrorState(props) {
      return h('div', { className: 'eng-error-state', role: 'alert' },
        h('div', { className: 'eng-error-title' }, (props && props.title) || '读取失败'),
        h('div', { className: 'eng-muted' }, (props && props.message) || '未知错误'),
        props && typeof props.onRetry === 'function' ? h(Button, { small: true, onClick: props.onRetry }, '重试') : null)
    }
    function Kbd(props) {
      return h('kbd', { className: 'eng-kbd' }, props.children)
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
        archive: 'M2 3.5h12v2.5H2V3.5Zm1 3.5h10v6.5H3V7Zm3.5 2h3',
        graph: 'M3 3h3v3H3V3Zm7 7h3v3h-3v-3ZM3 13h3v3H3v-3Zm4-9h3M6 6l3 3m2 4h3M14 10l-3-3',
        gear: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Zm5.4-2.2c0-.5-.1-.9-.2-1.3l1.5-1.1-1.4-2.4-1.8.7c-.6-.5-1.3-.9-2-1.2L9.2 1H6.8l-.3 1.7c-.7.3-1.4.7-2 1.2l-1.8-.7L1.3 5.6l1.5 1.1c-.1.4-.2.8-.2 1.3s.1.9.2 1.3L1.3 10.4l1.4 2.4 1.8-.7c.6.5 1.3.9 2 1.2l.3 1.7h2.4l.3-1.7c.7-.3 1.4-.7 2-1.2l1.8.7 1.4-2.4-1.5-1.1c.1-.4.2-.8.2-1.3Z',
        expand: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
        collapse: 'M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4',
      }
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: '0 0 auto', opacity: .9 } },
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

    /** 轻量提示：组件树外也能调用（复制成功/失败），Console 统一收集成 Toast。 */
    function toast(message, tone = 'ok') {
      try {
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('eng-toast', { detail: { message: String(message), tone } }))
      } catch { /* 无 window 的测试环境忽略 */ }
    }

    /** 顶部刷新：不重挂页面，通知各页自己 reload，保留选中与滚动。 */
    function useRefreshEvent(reload) {
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const handler = () => { try { reload() } catch { /* 页面已卸载 */ } }
        window.addEventListener('eng-refresh', handler)
        return () => window.removeEventListener('eng-refresh', handler)
      }, [reload])
    }

    /** 模态焦点生命周期：初始焦点、Tab 循环、Esc 关闭、关闭后还原。 */
    function useModalFocus(ref, onClose, enabled = true) {
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      useEffect(() => {
        if (!enabled || typeof document === 'undefined') return undefined
        const node = ref.current
        if (node === null) return undefined
        const previous = document.activeElement
        const focusables = () => [...node.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((item) => !item.disabled)
        const first = focusables()[0]
        if (first && typeof first.focus === 'function') first.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (typeof closeRef.current === 'function') closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = focusables()
          if (items.length === 0) return
          const firstItem = items[0]
          const lastItem = items[items.length - 1]
          if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus() }
          else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus() }
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          if (previous && typeof previous.focus === 'function') previous.focus()
        }
      }, [ref, enabled])
    }

    const SHORTCUTS = [
      ['Ctrl / Cmd + K', '命令面板'],
      ['?', '快捷键表'],
      ['g 然后 o / e / r / n / s / t / u / ,', '跳概览 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置'],
      ['j / k / Enter', '列表下移 / 上移 / 打开'],
      ['Ctrl / Cmd + Enter', '表单提交'],
      ['Shift + R', '刷新当前页'],
      ['Esc', '关闭最上层'],
    ]

    function ShortcutsDialog(props) {
      const modalRef = useRef(null)
      useModalFocus(modalRef, props.onClose, true)
      return h('div', { className: 'eng-modal-mask', role: 'dialog', 'aria-modal': 'true', 'aria-label': '快捷键' },
        h('div', { className: 'eng-modal', ref: modalRef },
          h('h3', { className: 'eng-modal-title' }, '快捷键'),
          h('div', { className: 'eng-shortcut-list' }, SHORTCUTS.map(([keys, label]) => h('div', { key: keys, className: 'eng-shortcut-row' },
            h(Kbd, null, keys), h('span', { className: 'eng-muted' }, label)))),
          h('div', { className: 'eng-modal-actions' }, h(Button, { onClick: props.onClose }, '关闭'))))
    }

    function CommandPalette(props) {
      const [query, setQuery] = useState('')
      const [index, setIndex] = useState(0)
      const inputRef = useRef(null)
      const modalRef = useRef(null)
      useModalFocus(modalRef, props.onClose, true)
      const items = props.items.filter((item) => {
        const needle = query.trim().toLowerCase()
        return needle === '' || item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle)
      })
      useEffect(() => { if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus() }, [])
      useEffect(() => { setIndex(0) }, [query])
      const run = (item) => { props.onClose(); if (item && typeof item.run === 'function') item.run() }
      return h('div', { className: 'eng-modal-mask', role: 'dialog', 'aria-modal': 'true', 'aria-label': '命令面板' },
        h('div', { className: 'eng-modal eng-palette', ref: modalRef },
          h('input', {
            ref: inputRef,
            className: 'eng-input eng-palette-input',
            placeholder: '输入命令，例如「记录」「刷新」「导入」…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(Math.min(items.length - 1, index + 1)) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(Math.max(0, index - 1)) }
              else if (event.key === 'Enter') { event.preventDefault(); run(items[index]) }
              else if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
            },
          }),
          items.length === 0
            ? h(Empty, null, '没有匹配的命令')
            : h('div', { className: 'eng-palette-list', role: 'listbox' }, items.map((item, itemIndex) => h('button', {
              key: item.id,
              type: 'button',
              role: 'option',
              'aria-selected': itemIndex === index ? 'true' : 'false',
              className: 'eng-palette-item',
              'data-active': itemIndex === index ? 'true' : 'false',
              onMouseEnter: () => setIndex(itemIndex),
              onClick: () => run(item),
            }, h('span', { className: 'eng-palette-group' }, item.group), h('span', { className: 'eng-palette-label' }, item.label)))),
          h('div', { className: 'eng-palette-foot' }, h(Kbd, null, '↑↓'), '选择', h(Kbd, null, 'Enter'), '执行', h(Kbd, null, 'Esc'), '关闭')))
    }

    /** 7 日调用迷你柱条：只表达趋势，不替代图表库。 */
    function Sparkline(props) {
      const points = Array.isArray(props.points) ? props.points : []
      const max = Math.max(1, ...points.map((point) => Number(point.count) || 0))
      return h('div', { className: 'eng-spark', role: 'img', 'aria-label': props.label || '最近 7 天调用' },
        points.map((point, index) => h('div', { key: index, className: 'eng-spark-col', title: `${point.date} · ${point.count} 次` },
          h('div', { className: 'eng-spark-bar', style: { height: `${Math.round(((Number(point.count) || 0) / max) * 100)}%` } }))))
    }

    /** 数字 KPI：首次进场 400ms 计数；尊重 reduced-motion，非数字原样显示。 */
    function Metric(props) {
      const target = Number(props.value)
      const numeric = props.value !== null && props.value !== '' && props.value !== undefined && Number.isFinite(target)
      const [display, setDisplay] = useState(numeric ? 0 : props.value)
      const fromRef = useRef(numeric ? 0 : 0)
      useEffect(() => {
        if (!numeric) { setDisplay(props.value); return undefined }
        const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (reduce || typeof requestAnimationFrame !== 'function') { setDisplay(props.value); fromRef.current = target; return undefined }
        const from = Number(fromRef.current) || 0
        const started = Date.now()
        let raf = 0
        const tick = () => {
          const progress = Math.min(1, (Date.now() - started) / 400)
          const eased = 1 - Math.pow(1 - progress, 3)
          setDisplay(Math.round(from + (target - from) * eased))
          if (progress < 1) {
            raf = requestAnimationFrame(tick)
          } else {
            fromRef.current = target
          }
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
      }, [props.value, numeric, target])
      return h('span', null, display === undefined || display === null ? '—' : String(display))
    }

    function Overview(props) {
      const recent = useLoad(useCallback(() => request('/experiences?limit=6'), []))
      const pending = useLoad(useCallback(() => request('/pending'), []))
      useRefreshEvent(useCallback(() => { recent.reload(); pending.reload() }, [recent.reload, pending.reload]))
      const [coldOpen, setColdOpen] = useState(Boolean(props.state && props.state.cold && Number(props.state.cold.total) > 0))
      const [notice, setNotice] = useState('')
      const state = props.state || {}
      const totals = state.totals || {}
      const usage = state.usage || {}
      const summary = state.skillSummary || {}
      const storage = state.storage !== null && typeof state.storage === 'object' ? state.storage : null
      const cold = state.cold !== null && typeof state.cold === 'object' ? state.cold : { years: [], total: 0, samples: [] }
      const legacy = storage !== null && storage.legacy !== null && typeof storage.legacy === 'object' ? storage.legacy : { exists: false, bytes: 0 }
      const byDay = Array.isArray(usage.byDay) ? usage.byDay : []
      const byCategory = state.stats && typeof state.stats === 'object' && state.stats.byCategory && typeof state.stats.byCategory === 'object' ? state.stats.byCategory : {}
      const typeRows = Object.entries(byCategory).sort((left, right) => (Number(right[1]) || 0) - (Number(left[1]) || 0)).slice(0, 6)
      const typeMax = Math.max(1, ...typeRows.map(([, value]) => Number(value) || 0))
      const pendingRows = Array.isArray(pending.data) ? pending.data : []
      const kpis = [
        ['可见经验', totals.visible, '条'],
        ['固化技能', totals.skills, '个'],
        ['今日调用', usage.today, '次'],
        ['库大小', fmtBytes(state.bytes), ''],
      ]
      const backfill = async (row, outcome) => {
        setNotice('')
        try {
          await request('/verdicts', { method: 'POST', body: { verdicts: [{ id: row.id, outcome }] } })
          await pending.reload()
          if (typeof props.onChanged === 'function') props.onChanged()
        } catch (error) {
          setNotice(error && error.message ? error.message : String(error))
        }
      }
      const storageCell = (label, main, sub) => h('div', { key: label, style: { minWidth: 0 } },
        h('div', { className: 'eng-kpi-label' }, label),
        h('div', { className: 'eng-stat-main' }, main),
        sub ? h('div', { className: 'eng-muted' }, sub) : null)
      return h('div', { className: 'eng-fill' },
        h('div', { className: 'eng-scroll' },
          h('div', { className: 'eng-grid' }, kpis.map(([label, value, unit]) => h('div', { key: label, className: 'eng-card eng-kpi' },
            h('span', { className: 'eng-kpi-label' }, label),
            h('span', { className: 'eng-kpi-value' }, h(Metric, { value }), h('span', { className: 'eng-kpi-unit' }, unit))))),
          h('div', { className: 'eng-cols eng-section' },
            h('div', { className: 'eng-card eng-section-card' },
              h('div', { className: 'eng-section-head' },
                h('h3', { className: 'eng-section-title' }, '最近 7 天调用'),
                h('span', { className: 'eng-muted' }, `合计 ${byDay.reduce((sum, point) => sum + (Number(point.count) || 0), 0)} 次`)),
              byDay.length === 0
                ? h(Empty, null, '暂无调用记录')
                : h(Sparkline, { points: byDay, label: '最近 7 天调用次数' })),
            h('div', { className: 'eng-card eng-section-card' },
              h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, '类型分布')),
              typeRows.length === 0 ? h(Empty, null, '还没有类型数据') : h('div', { className: 'eng-dist' },
                typeRows.map(([name, value]) => h('div', { key: name, className: 'eng-dist-row' },
                  h('span', { className: 'eng-row-intent', title: name }, name),
                  h('div', { className: 'eng-dist-track' }, h('div', { className: 'eng-dist-fill', style: { width: `${Math.round(((Number(value) || 0) / typeMax) * 100)}%` } })),
                  h('span', { className: 'eng-mono', style: { textAlign: 'right' } }, String(value))))))),
          notice ? h(Banner, { bad: true }, notice) : null,
          h('div', { className: 'eng-card eng-section eng-section-card' },
            h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, '存储结构')),
            storage === null
              ? h('div', { className: 'eng-muted' }, '暂无存储信息')
              : h('div', { className: 'eng-storage-grid' },
                storageCell('manifest', fmtBytes(storage.manifestBytes), '分片索引'),
                storageCell('分片', `${storage.bucketFiles || 0} 个`, fmtBytes(storage.bucketBytes)),
                storageCell('冷档', Number(storage.coldFiles) > 0 ? fmtBytes(storage.coldBytes) : '暂无', Number(storage.coldFiles) > 0 ? `${storage.coldFiles} 个文件` : '安全阀未触发'),
                storageCell('legacy', legacy.exists ? fmtBytes(legacy.bytes) : '无', legacy.exists ? '可删' : '已无旧库')),
            storage !== null ? h('div', { className: 'eng-muted eng-section-note' },
              `总计 ${fmtBytes(storage.totalBytes)} · ${storage.fileCount || 0} 个文件`,
              legacy.exists ? '；legacy 为迁移前快照，仅用于回滚（可删）' : '') : null,
            h('div', { className: 'eng-subsection' },
              h('button', { type: 'button', className: 'eng-subsection-head', 'aria-expanded': coldOpen ? 'true' : 'false', onClick: () => setColdOpen((open) => !open) },
                h('span', { className: 'eng-strong' }, '冷档'),
                h('span', { className: 'eng-muted' }, cold.error ? '读取失败' : (Number(cold.total) > 0 ? `${cold.total} 条 · ${coldOpen ? '收起' : '展开'}` : '暂无冷档'))),
              cold.error
                ? h(Banner, { bad: true }, `冷档读取失败：${cold.error}`)
                : (Number(cold.total) || 0) === 0
                  ? h('div', { className: 'eng-muted eng-subsection-body' }, '暂无冷档（容量安全阀未触发）')
                  : coldOpen
                    ? h('div', { className: 'eng-subsection-body' },
                      (cold.years || []).map((year) => h('div', { key: String(year.year), className: 'eng-muted' },
                        `${year.year} 年 · ${year.count} 条 · ${fmtBytes(year.bytes)}`)),
                      (cold.samples || []).slice(0, 50).map((row) => h('div', { key: row.id, className: 'eng-cold-row' },
                        h('span', { className: 'eng-mono' }, row.id),
                        h('span', { className: 'eng-row-main' }, row.intent || '（无意图）'),
                        h('span', { className: 'eng-muted' }, `${row.typeName || '未分类'} · ${fmtTime(row.lastSeenAt)}`))))
                    : null)),
          h('div', { className: 'eng-cols eng-section' },
            h('div', { className: 'eng-card' },
              h('div', { className: 'eng-section-head eng-section-head-pad' },
                h('h3', { className: 'eng-section-title' }, '最近经验'),
                h(Button, { small: true, onClick: () => props.onGo('experiences') }, '全部')),
              recent.error ? h(Banner, { bad: true }, recent.error) : null,
              recent.data && recent.data.rows && recent.data.rows.length > 0
                ? h('div', { className: 'eng-list' }, recent.data.rows.slice(0, 6).map((row) => {
                  const [label, tone] = outcomeOf(row.outcome)
                  return h('button', { key: row.id, type: 'button', className: 'eng-row eng-row-button', style: { gridTemplateColumns: '60px minmax(0,1fr) 70px' }, onClick: () => props.onOpen(row.id) },
                    h(Badge, { tone }, label),
                    h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || '（无意图）'), h('div', { className: 'eng-row-sub' }, `${row.typeName || '未分类'} · ${row.action || '—'}`)),
                    h('span', { className: 'eng-mono', style: { textAlign: 'right' } }, `G ${fmtNumber(row.G)}`))
                }))
                : (recent.loading ? h(Skeleton, { rows: 4 }) : h(Empty, null, '还没有经验：去「记录」写第一条。'))),
            h('div', { className: 'eng-stack' },
              h('div', { className: 'eng-card eng-section-card' },
                h('div', { className: 'eng-section-head' },
                  h('h3', { className: 'eng-section-title' }, `待判定（${pendingRows.length}）`),
                  h(Button, { small: true, onClick: () => props.onGo('usage') }, '全部')),
                pending.error ? h(Banner, { bad: true }, pending.error) : null,
                pendingRows.length === 0
                  ? h('div', { className: 'eng-muted' }, pending.loading ? '读取中…' : '没有待判定的记录')
                  : h('div', { className: 'eng-stack' }, pendingRows.slice(0, 3).map((row) => h('div', { key: row.id, className: 'eng-pending-row' },
                    h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || row.action || '—'), row.brief ? h('div', { className: 'eng-row-sub' }, row.brief) : null),
                    h('div', { className: 'eng-actions' },
                      h(Button, { small: true, onClick: () => backfill(row, 'success') }, '成功'),
                      h(Button, { small: true, onClick: () => backfill(row, 'corrected') }, '纠正'),
                      h(Button, { small: true, onClick: () => backfill(row, 'failed') }, '失败')))))),
              h('div', { className: 'eng-card eng-section-card' },
                h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, '快捷操作')),
                h('div', { className: 'eng-actions' },
                  h(Button, { kind: 'primary', onClick: () => props.onGo('record') }, '记录经验'),
                  h(Button, { onClick: () => props.onGo('recall') }, '检索召回'),
                  h(Button, { onClick: () => props.onGo('skills') }, '沉淀技能'))),
              h('div', { className: 'eng-card eng-section-card' },
                h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, '技能状态')),
                h('div', { className: 'eng-chipbar' }, ['solid', 'trial', 'risky', 'blocked', 'new'].map((key) => {
                  const [label, tone] = skillStateOf(key)
                  return h(Badge, { key, tone }, `${label} ${summary[key] || 0}`)
                })),
                h('div', { className: 'eng-muted eng-section-note' }, state.notice || `共 ${totals.types || 0} 个类型`))))))
    }

    function Experiences(props) {
      const [searchDraft, setSearchDraft] = useState('')
      const [type, setType] = useState('')
      const [outcome, setOutcome] = useState('')
      const [sort, setSort] = useState('recent')
      const [pageSize, setPageSize] = useState(50)
      const [page, setPage] = useState(0)
      const [selected, setSelected] = useState(props.focusId || null)
      const [sending, setSending] = useState(false)
      const [notice, setNotice] = useState('')
      const detailRef = useRef(null)
      useEffect(() => { if (props.focusId) setSelected(props.focusId) }, [props.focusId])
      const list = useLoad(useCallback(() => {
        const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize), sort })
        if (type !== '') params.set('type', type)
        if (outcome !== '') params.set('outcome', outcome)
        return request(`/experiences?${params.toString()}`)
      }, [type, outcome, sort, page, pageSize]))
      // 换筛选/排序/页大小时回到第一页，避免停在越界页码。
      useEffect(() => { setPage(0) }, [type, outcome, sort, pageSize])
      useRefreshEvent(list.reload)
      const detail = useLoad(useCallback(() => selected === null ? Promise.resolve(null) : request(`/experience?id=${encodeURIComponent(selected)}`), [selected]))
      // 窄面板下列表与详情会被压成一列：选中后把详情卡片滚进视野，否则看起来「点了没反应」。
      useEffect(() => {
        const node = detailRef.current
        if (selected === null || node === null || typeof node.scrollIntoView !== 'function') return
        node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, [selected, detail.data])
      const types = (props.state && props.state.types) || []
      const rows = (list.data && (list.data.rows || list.data.candidates)) || []
      // j/k 在列表里移动选中；输入框/文本域里不拦截。
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const handler = (event) => {
          const tag = event.target && event.target.tagName ? String(event.target.tagName) : ''
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return
          if (event.key !== 'j' && event.key !== 'k') return
          if (rows.length === 0) return
          const currentIndex = rows.findIndex((row) => row.id === selected)
          const nextIndex = Math.max(0, Math.min(rows.length - 1, (currentIndex < 0 ? 0 : currentIndex + (event.key === 'j' ? 1 : -1))))
          event.preventDefault()
          setSelected(rows[nextIndex].id)
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
      }, [rows, selected])
      const total = list.data ? Number(list.data.total) || 0 : 0
      const pages = Math.max(1, Math.ceil(total / pageSize))
      const storeError = list.data && list.data.storeError
      const send = async (result) => {
        if (selected === null || sending) return
        setSending(true)
        setNotice('')
        const detailSnapshot = detail.data
        const listSnapshot = list.data
        const target = result === 'helped' ? 1 : result === 'hurt' ? -1 : null
        const optimisticG = (value) => target === null ? value : Math.round((Number(value) + 0.35 * (target - Number(value))) * 1e4) / 1e4
        // 乐观更新：先改当前行与列表里的 G/计数，请求回来再用服务端结果覆盖。
        if (detailSnapshot && detailSnapshot.row) {
          const row = detailSnapshot.row
          const feedback = { helped: 0, hurt: 0, neutral: 0, ...(row.feedback || {}) }
          if (target !== null) feedback[result] = (Number(feedback[result]) || 0) + 1
          detail.setData({ ...detailSnapshot, row: { ...row, G: optimisticG(row.G), feedback } })
        }
        if (listSnapshot && Array.isArray(listSnapshot.rows)) {
          list.setData({ ...listSnapshot, rows: listSnapshot.rows.map((row) => row.id === selected ? { ...row, G: optimisticG(row.G) } : row) })
        }
        try {
          await request('/feedback', { method: 'POST', body: { id: selected, result } })
          await Promise.all([list.reload(), detail.reload()])
          if (typeof props.onChanged === 'function') props.onChanged()
        } catch (error) {
          if (detailSnapshot !== undefined) detail.setData(detailSnapshot)
          if (listSnapshot !== undefined) list.setData(listSnapshot)
          setNotice(error && error.message ? error.message : String(error))
        } finally {
          setSending(false)
        }
      }
      const assign = async (id, typeName) => {
        await request('/type', { method: 'POST', body: { action: 'assign', id, name: typeName } })
        await Promise.all([list.reload(), detail.reload()])
        props.onChanged()
      }
      const labelCatalog = useLoad(useCallback(() => request('/type', { method: 'POST', body: { action: 'labels' } }), []))
      const addLabels = async (id, tags) => {
        await request('/type', { method: 'POST', body: { action: 'label', id, labels: tags } })
        await Promise.all([list.reload(), detail.reload(), labelCatalog.reload()])
        props.onChanged()
      }
      const autoAssign = async (id) => {
        const out = await request('/classify', { method: 'POST', body: { id } })
        await Promise.all([list.reload(), detail.reload()])
        props.onChanged()
        return out
      }
      return h('div', { className: 'eng-fill' },
        list.error ? h(Banner, { bad: true }, list.error) : null,
        storeError ? h(Banner, { bad: true }, `经验数据读取失败：${storeError.message}${storeError.file ? `（${storeError.file}）` : ''}`) : null,
        notice ? h(Banner, { bad: true }, notice) : null,
        h('div', { className: 'eng-toolbar' },
          h('input', { className: 'eng-input', placeholder: '按意图检索（回车跳到检索页）…', value: searchDraft, onChange: (event) => setSearchDraft(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && searchDraft.trim() !== '') props.onSearch(searchDraft.trim()) } }),
          h('select', { className: 'eng-select', value: type, onChange: (event) => setType(event.target.value) },
            h('option', { value: '' }, '全部类型'), types.map((item) => h('option', { key: item.id, value: item.id }, item.name))),
          h('select', { className: 'eng-select', value: outcome, onChange: (event) => setOutcome(event.target.value) },
            h('option', { value: '' }, '全部结果'), Object.keys(OUTCOMES).map((key) => h('option', { key, value: key }, OUTCOMES[key][0]))),
          h('select', { className: 'eng-select', style: { width: 120 }, value: sort, onChange: (event) => setSort(event.target.value) },
            h('option', { value: 'recent' }, '最近'),
            h('option', { value: 'g' }, 'G'),
            h('option', { value: 'hits' }, '用过次数'),
            h('option', { value: 'type' }, '类型')),
          h('span', { className: 'eng-muted' }, `${total} 条`),
          h(Button, { small: true, disabled: searchDraft.trim() === '', onClick: () => props.onSearch(searchDraft.trim()) }, '检索'),
          h(Button, { small: true, disabled: list.loading, onClick: list.reload }, list.loading ? '刷新中…' : '刷新')),
        h('div', { className: 'eng-split', 'data-open': selected === null ? 'false' : 'true' },
          h('div', { className: 'eng-card' },
            rows.length === 0
              ? (list.loading ? h(Skeleton, { rows: 6 }) : list.error ? h(ErrorState, { message: list.error, onRetry: list.reload }) : h(Empty, null, '没有符合条件的经验'))
              : h('div', { className: 'eng-list' }, rows.map((row) => {
              const [label, tone] = outcomeOf(row.outcome)
              return h('button', { key: row.id, type: 'button', className: 'eng-row eng-row-button', 'data-on': selected === row.id ? 'true' : 'false', onClick: () => setSelected(row.id) },
                h(Badge, { tone }, label),
                h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || '（无意图）'), h('div', { className: 'eng-row-sub' }, `${row.typeName || '未分类'} · ${row.action || '—'}`)),
                h('span', { className: 'eng-mono' }, `G ${fmtNumber(row.G)}`),
                h('span', { className: 'eng-muted' }, fmtTime(row.lastSeenAt || row.ts)))
            })),
            h('div', { className: 'eng-pager' },
              h('span', { className: 'eng-muted' }, `共 ${total} 条 · 第 ${page + 1}/${pages} 页`),
              h('select', { className: 'eng-select', style: { width: 96 }, value: String(pageSize), onChange: (event) => setPageSize(Number(event.target.value)) },
                [50, 100, 200].map((size) => h('option', { key: size, value: String(size) }, `${size} 条/页`))),
              h(Button, { small: true, disabled: page <= 0, onClick: () => setPage(page - 1) }, '上一页'),
              h(Button, { small: true, disabled: page + 1 >= pages, onClick: () => setPage(page + 1) }, '下一页'))),
          h('div', { className: 'eng-card eng-detail-card', ref: detailRef },
            h(DetailPane, { key: selected === null ? 'empty' : selected, selected, detail, send, busy: sending, types, onAssign: assign, labelOptions: (labelCatalog.data && labelCatalog.data.labels) || [], onAddLabels: addLabels, onAutoAssign: autoAssign, onClose: () => setSelected(null) }))))
    }

    /**
     * 右侧详情面板。单独抽成组件：既让「选中 → 详情」有可渲染的单元测试，
     * 也避免再出现「内联立即执行函数漏了调用、React 收到函数子节点渲染空白」那类事故。
     */
    function DetailPane(props) {
      const { selected, detail, send, onClose, busy } = props
      const [assignTo, setAssignTo] = useState('')
      const [assigning, setAssigning] = useState(false)
      const [assignMessage, setAssignMessage] = useState('')
      const [labelPick, setLabelPick] = useState('')
      const [newLabel, setNewLabel] = useState('')
      const [labelBusy, setLabelBusy] = useState(false)
      const [labelMessage, setLabelMessage] = useState('')
      const [pane, setPane] = useState('overview')
      useEffect(() => { setAssignTo(''); setAssigning(false); setAssignMessage(''); setLabelPick(''); setNewLabel(''); setLabelBusy(false); setLabelMessage(''); setPane('overview') }, [selected])
      if (selected === null) return h(Empty, null, '选一条经验看详情')
      if (detail && detail.error) return h(ErrorState, { title: '读取详情失败', message: detail.error, onRetry: detail.reload })
      const data = detail ? detail.data : null
      if (data === null || data === undefined || !data.row) return h(Empty, null, '读取中…')
      const row = data.row
      const [label, tone] = outcomeOf(row.outcome)
      const life = row.lifecycle || {}
      const lifeBits = [
        life.supersededBy ? `被取代（${life.supersededBy}）` : '',
        life.retiredAt ? `退休 ${fmtTime(life.retiredAt)}` : '',
        life.deletedAt ? `删除 ${fmtTime(life.deletedAt)}` : '',
      ].filter((item) => item !== '')
      const events = Array.isArray(data.history) ? data.history : []
      const feedbackLog = Array.isArray(data.feedbackLog) ? data.feedbackLog : []
      const types = Array.isArray(props.types) ? props.types.filter((item) => item && item.system !== true) : []
      const assignable = typeof props.onAssign === 'function' && types.length > 0
      const copyJson = () => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(JSON.stringify(data, null, 2))
          toast('已复制 JSON')
        } catch { /* 剪贴板不可用就算了 */ }
      }
      const tabs = [['overview', '概览'], ['history', `历史 ${events.length}`], ['feedback', `反馈 ${feedbackLog.length}`], ['raw', '原始']]
      const body = pane === 'history'
        ? (events.length === 0 ? h(Empty, null, '没有历史事件') : h('div', { className: 'eng-timeline' }, events.slice(-20).reverse().map((event, index) => h('div', { key: index, className: 'eng-timeline-item' },
          h('span', { className: 'eng-mono' }, fmtTime(event && event.at)),
          h('span', { className: 'eng-strong' }, (event && event.type) || '事件'),
          h('span', { className: 'eng-muted' }, [event && event.result, event && event.reason, event && event.by].filter(Boolean).join(' · ') || '—')))))
        : pane === 'feedback'
          ? (feedbackLog.length === 0 ? h(Empty, null, '没有反馈记录') : h('div', { className: 'eng-timeline' }, feedbackLog.slice(-20).reverse().map((event, index) => h('div', { key: index, className: 'eng-timeline-item' },
            h('span', { className: 'eng-mono' }, fmtTime(event && event.at)),
            h(Badge, { tone: event && event.result === 'helped' ? 'ok' : event && event.result === 'hurt' ? 'bad' : 'muted' }, (event && event.result) || '反馈'),
            h('span', { className: 'eng-muted' }, row.feedback ? `累计 有帮助 ${row.feedback.helped || 0} / 没帮上 ${row.feedback.hurt || 0}` : '—')))))
          : pane === 'raw'
            ? h('div', null,
              h('div', { className: 'eng-actions', style: { marginBottom: 8 } }, h(Button, { small: true, onClick: copyJson }, '复制 JSON')),
              h('pre', { className: 'eng-pre eng-pre-json' }, JSON.stringify(data, null, 2)))
            : h('div', null,
              assignable ? h('div', { className: 'eng-actions', style: { marginBottom: 12, flexWrap: 'wrap' } },
                h('span', { className: 'eng-label' }, '分类'),
                h('select', { className: 'eng-select', style: { width: 170 }, value: assignTo, onChange: (event) => setAssignTo(event.target.value) },
                  h('option', { value: '' }, '选择主分类…'),
                  types.map((item) => h('option', { key: item.id, value: item.name }, item.name))),
                h(Button, { small: true, disabled: assigning || assignTo === '' || assignTo === row.typeName, onClick: async () => {
                  setAssigning(true)
                  setAssignMessage('')
                  try { await props.onAssign(row.id, assignTo); setAssignMessage(`已移到「${assignTo}」`) } catch (error) { setAssignMessage(error && error.message ? error.message : '分类失败') } finally { setAssigning(false) }
                } }, assigning ? '移动中…' : '移到该分类'),
                assignMessage ? h('span', { className: 'eng-muted' }, assignMessage) : null,
                typeof props.onAutoAssign === 'function' ? h(Button, { small: true, disabled: assigning, onClick: async () => {
                  setAssigning(true)
                  setAssignMessage('')
                  try { const out = await props.onAutoAssign(row.id); setAssignMessage(`已分到「${out.typeName}」${out.classifier === 'local' ? '（本地兜底，未耗模型）' : '（临时会话）'}`) } catch (error) { setAssignMessage(error && error.message ? error.message : '自动分类失败') } finally { setAssigning(false) }
                } }, '一键分类') : null,
                typeof props.onAutoAssign === 'function' ? h(Tip, { text: '一键分类会拉起一次性临时会话（不注入工具/历史、只发最小文本），会产生额外 Token 消费' }) : null) : null,
              typeof props.onAddLabels === 'function' ? h('div', { className: 'eng-actions', style: { marginBottom: 12, flexWrap: 'wrap' } },
                h('span', { className: 'eng-label' }, '标签'),
                h('select', { className: 'eng-select', style: { width: 150 }, value: labelPick, onChange: (event) => setLabelPick(event.target.value) },
                  h('option', { value: '' }, '选择已有标签…'),
                  (Array.isArray(props.labelOptions) ? props.labelOptions : []).filter((item) => !(Array.isArray(row.context) && row.context.includes(item.name))).map((item) => h('option', { key: item.name, value: item.name }, `${item.name} (${item.count})`))),
                h('input', { className: 'eng-input', style: { width: 140 }, placeholder: '新建标签…', value: newLabel, onChange: (event) => setNewLabel(event.target.value) }),
                h(Button, { small: true, disabled: labelBusy || (labelPick === '' && newLabel.trim() === ''), onClick: async () => {
                  const tags = [...(labelPick === '' ? [] : [labelPick]), ...newLabel.split(/[,，]/).map((item) => item.trim()).filter(Boolean)]
                  setLabelBusy(true)
                  setLabelMessage('')
                  try { await props.onAddLabels(row.id, tags); setLabelMessage('标签已添加'); setLabelPick(''); setNewLabel('') } catch (error) { setLabelMessage(error && error.message ? error.message : '添加失败') } finally { setLabelBusy(false) }
                } }, labelBusy ? '添加中…' : '添加标签'),
                labelMessage ? h('span', { className: 'eng-muted' }, labelMessage) : null) : null,
              h('dl', { className: 'eng-kv' },
                h('dt', null, '做法'), h('dd', null, row.action || '—'),
                h('dt', null, '分类'), h('dd', null, row.typeName || '未分类'),
                h('dt', null, '任务'), h('dd', null, row.kind === 'step' ? `步骤 ${row.stepIndex || '?'} / ${row.stepTotal || '?'}` : (row.kind || '整条')),
                h('dt', null, '标签'), h('dd', null, Array.isArray(row.context) && row.context.length ? row.context.join('、') : '无'),
                Array.isArray(row.dimensions) && row.dimensions.length > 0 ? h('dt', null, '维度') : null,
                Array.isArray(row.dimensions) && row.dimensions.length > 0 ? h('dd', null, row.dimensions.join('、')) : null,
                row.expectedG === null || row.expectedG === undefined ? null : h('dt', null, '预期 G'),
                row.expectedG === null || row.expectedG === undefined ? null : h('dd', null, `${fmtNumber(row.expectedG)}（误差 ${fmtNumber((Number(row.G) || 0) - Number(row.expectedG))}）`),
                h('dt', null, '反馈'), h('dd', null, row.feedback ? `有帮助 ${row.feedback.helped || 0} / 没帮上 ${row.feedback.hurt || 0}` : '无'),
                row.retrievals > 0 ? h('dt', null, '主动提取') : null,
                row.retrievals > 0 ? h('dd', null, `${row.retrievals} 次`) : null,
                h('dt', null, '判定'), h('dd', null, row.verdict === 'pending' ? '待判定' : (row.verdict || '—')),
                h('dt', null, 'id'), h('dd', { className: 'eng-mono' }, row.id)),
              row.note ? h('div', { className: 'eng-note' }, h('div', { className: 'eng-label' }, '备注'), h('div', { className: 'eng-pre' }, row.note)) : null)
      return h('div', { className: 'eng-detail' },
        h('div', { className: 'eng-actions' }, h(Badge, { tone }, label), h('span', { className: 'eng-mono' }, `G ${fmtNumber(row.G)}`)),
        h('h3', { className: 'eng-detail-title' }, row.intent || '（无意图）'),
        lifeBits.length > 0 ? h('div', { className: 'eng-muted eng-warn-text' }, lifeBits.join(' · ')) : null,
        h('div', { className: 'eng-tabs', role: 'tablist' }, tabs.map(([key, text]) => h('button', {
          key, type: 'button', role: 'tab', className: 'eng-tab', 'data-active': pane === key ? 'true' : 'false', 'aria-selected': pane === key ? 'true' : 'false',
          onClick: () => setPane(key),
        }, text))),
        h('div', { className: 'eng-tab-body' }, body),
        h('div', { className: 'eng-actions eng-detail-actions' },
          h(Button, { small: true, disabled: busy, onClick: () => send('helped') }, '有帮助'),
          h(Button, { small: true, disabled: busy, onClick: () => send('hurt') }, '没帮上'),
          h(Button, { small: true, disabled: busy, onClick: () => send('neutral') }, '中性'),
          h(Button, { small: true, onClick: onClose }, '收起')))
    }

    function Recall(props) {
      const [intent, setIntent] = useState((props && props.seed) || '')
      const [context, setContext] = useState('')
      const [cluster, setCluster] = useState('')
      const [flags, setFlags] = useState({ all: false, cold: false, detail: false, mark: false })
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const types = Array.isArray(props && props.types) ? props.types : []
      const toggle = (key) => setFlags((previous) => ({ ...previous, [key]: !previous[key] }))
      const run = async () => {
        setBusy(true); setError('')
        try {
          const body = { intent, context: context.trim() === '' ? [] : context.split(/[,，]/).map((item) => item.trim()).filter(Boolean), limit: 8 }
          if (flags.all) body.all = true
          if (flags.cold) body.cold = true
          if (flags.detail) body.detail = true
          if (flags.mark) body.mark = true
          if (cluster !== '') body.cluster = cluster
          setResult(await request('/recall', { method: 'POST', body }))
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
      const backfill = async (id, outcome) => {
        try {
          await request('/verdicts', { method: 'POST', body: { verdicts: [{ id, outcome }] } })
          await run()
        } catch (caught) {
          setError(caught.message || String(caught))
        }
      }
      const candidates = result ? (result.candidates || result.rows || []) : []
      const recent = result && Array.isArray(result.recent) ? result.recent : []
      const pendingRows = result && Array.isArray(result.pending) ? result.pending : []
      const route = result && result.route !== null && typeof result.route === 'object' ? result.route : null
      const engineShape = candidates.some((item) => Array.isArray(item.evidence))
      const copyResult = () => {
        try {
          const lines = []
          if (result.brief) lines.push(`> ${result.brief}`)
          if (result.skill) lines.push(`## 技能：${result.skill.name}\n${result.skill.body}`)
          for (const candidate of candidates) {
            lines.push(`## ${candidate.action || '（无做法）'}（Â ${fmtNumber(candidate.advantage)}，support ${candidate.support || 0}）`)
            for (const evidence of candidate.evidence || []) lines.push(`- [${evidence.outcome}] G ${fmtNumber(evidence.G)} · ${evidence.intent || ''}${evidence.note ? ` — ${evidence.note}` : ''}`)
          }
          if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(lines.join('\n'))
          toast('已复制检索结果')
        } catch { /* 剪贴板不可用就算了 */ }
      }
      return h('div', { className: 'eng-fill' },
        error ? h(Banner, { bad: true }, error) : null,
        h('div', { className: 'eng-card', style: { padding: 16, marginBottom: 14 } },
          h('div', { className: 'eng-form-grid' },
            h(Field, { label: '意图', wide: true, hint: '走内核 JitRL 召回（技能模式优先返回技能正文）' },
              h('textarea', { className: 'eng-textarea', placeholder: '例如：把课件导出成 PDF，字体要嵌进去', value: intent, onChange: (event) => setIntent(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) run() } })),
            h(Field, { label: '标签（逗号分隔，可选）' }, h('input', { className: 'eng-input', placeholder: '插件, 主题, 性能', value: context, onChange: (event) => setContext(event.target.value) }))),
          h('details', { style: { marginTop: 8 } },
            h('summary', { className: 'eng-label', style: { cursor: 'pointer' } }, '高级（全库 / 冷档 / 簇 / 明细 / 标记）'),
            h('div', { className: 'eng-actions', style: { marginTop: 8 } },
              [['all', '全库检索（忽略路由）'], ['cold', '只查冷档'], ['detail', '返回明细（不瘦身）'], ['mark', '记为主动提取']].map(([key, label]) =>
                h('label', { key, className: 'eng-actions', style: { fontWeight: 400 } },
                  h('input', { type: 'checkbox', checked: flags[key] === true, onChange: () => toggle(key) }),
                  h('span', { className: 'eng-muted' }, label))),
              h('select', { className: 'eng-select', style: { width: 160 }, value: cluster, onChange: (event) => setCluster(event.target.value) },
                h('option', { value: '' }, '自动选簇'),
                types.filter((item) => item && item.system !== true).map((item) => h('option', { key: item.id, value: item.name }, item.name))))),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy || intent.trim() === '', onClick: run }, busy ? '检索中…' : '检索'))),
        h('div', { className: 'eng-scroll' },
          result === null ? h(Empty, null, '输入意图后点「检索」，候选会出现在这里') : h('div', null,
          h('div', { className: 'eng-actions', style: { marginBottom: 12 } },
            h(Badge, { tone: result.mode === 'skill' || result.mode === 'skill-trial' ? 'brand' : result.mode === 'advantage' ? 'ok' : 'muted' }, `mode=${result.mode}`),
            h('span', { className: 'eng-muted' }, `候选 ${candidates.length} 组`),
            result.cold ? h(Badge, { tone: 'warn' }, '冷档查询') : null,
            result.weak ? h(Badge, { tone: 'warn' }, `相关度低${result.topSimilarity === undefined ? '' : ` ${fmtNumber(result.topSimilarity)}`}`) : null,
            route ? h(Badge, { tone: route.fallback ? 'muted' : 'ok' }, route.fallback ? '回退全库' : `簇 ${route.name} · ${fmtNumber(route.score)}`) : null,
            result.pendingSkills ? h(Badge, { tone: 'warn' }, `待补提交 ${result.pendingSkills}`) : null,
            h(Button, { small: true, onClick: copyResult }, '复制结果')),
          result.brief ? h(Banner, null, result.brief) : null,
          pendingRows.length > 0 ? h('div', { className: 'eng-card', style: { padding: 16, marginBottom: 12 } },
            h('div', { className: 'eng-actions', style: { marginBottom: 8 } }, h('strong', null, `待判定（${pendingRows.length}）`), h('span', { className: 'eng-muted' }, '顺手回填，不用另开调用')),
            h('div', { className: 'eng-stack' }, pendingRows.map((row) => h('div', { key: row.id, className: 'eng-row', style: { gridTemplateColumns: '120px minmax(0,1fr) auto' } },
              h('span', { className: 'eng-mono' }, row.id),
              h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-sub' }, row.brief || '—')),
              h('div', { className: 'eng-actions' },
                h(Button, { small: true, onClick: () => backfill(row.id, 'success') }, '成功'),
                h(Button, { small: true, onClick: () => backfill(row.id, 'corrected') }, '纠正'),
                h(Button, { small: true, onClick: () => backfill(row.id, 'failed') }, '失败')))))) : null,
          result.skill ? h('div', { className: 'eng-card', style: { padding: 16, marginBottom: 12 } },
            h('div', { className: 'eng-actions', style: { marginBottom: 8 } }, h(Badge, { tone: 'brand' }, result.mode === 'skill-trial' ? '试用技能' : '高确定技能'), h('span', { className: 'eng-mono' }, result.skill.id)),
            h('h3', { className: 'eng-detail-title' }, result.skill.name),
            h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, result.skill.description),
            h('pre', { className: 'eng-pre' }, result.skill.body)) : null,
          recent.length > 0 ? h('div', { className: 'eng-card', style: { padding: 16, marginBottom: 12 } },
            h('div', { className: 'eng-actions', style: { marginBottom: 8 } }, h('strong', null, '最近做过'), h('span', { className: 'eng-muted' }, '同一会话的最近两条')),
            h('div', { className: 'eng-stack' }, recent.map((row) => {
              const [label, tone] = outcomeOf(row.outcome)
              return h('div', { key: row.id, className: 'eng-row', style: { gridTemplateColumns: '60px 64px minmax(0,1fr)', cursor: 'default' } },
                h(Badge, { tone }, label),
                h('span', { className: 'eng-mono' }, `G ${fmtNumber(row.G)}`),
                h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || '（无意图）'), h('div', { className: 'eng-row-sub' }, `${row.action || '—'} · sim ${fmtNumber(row.similarity)}`)))
            }))) : null,
          typeof result.induction === 'string' && result.induction !== '' ? h('details', { className: 'eng-card', style: { padding: 16, marginBottom: 12 } },
            h('summary', { className: 'eng-label', style: { cursor: 'pointer' } }, '归纳提示（原料，不是结论）'),
            h('pre', { className: 'eng-pre', style: { marginTop: 8 } }, result.induction)) : null,
          candidates.length === 0 ? h(Empty, null, result.note || '没有相近候选') : h('div', { className: 'eng-stack' }, candidates.map((item, index) => engineShape
            ? h('div', { key: item.action || index, className: 'eng-card', style: { padding: 14 } },
                h('div', { className: 'eng-actions', style: { marginBottom: 8 } },
                  h('strong', null, item.action || '（无做法）'),
                  h('span', { className: 'eng-mono' }, `Â ${fmtNumber(item.advantage)}`),
                  h('span', { className: 'eng-muted' }, `support ${item.support || 0} · sim ${fmtNumber(item.mean_similarity !== undefined ? item.mean_similarity : item.meanSimilarity)}`),
                  item.typeName ? h('span', { className: 'eng-muted' }, item.typeName) : null),
                h('div', { className: 'eng-stack' }, (item.evidence || []).map((evidence) => {
                  const [label, tone] = outcomeOf(evidence.outcome)
                  return h('div', { key: evidence.id, className: 'eng-row', style: { gridTemplateColumns: '60px 64px minmax(0,1fr) auto', cursor: 'default' } },
                    h(Badge, { tone }, label),
                    h('span', { className: 'eng-mono' }, `G ${fmtNumber(evidence.G)}`),
                    h('div', { className: 'eng-row-main' },
                      h('div', { className: 'eng-row-sub' }, `${evidence.id} · sim ${fmtNumber(evidence.similarity)}`),
                      evidence.intent ? h('div', { className: 'eng-row-sub' }, evidence.intent) : null,
                      evidence.note ? h('div', { className: 'eng-row-sub' }, evidence.note) : null,
                      Array.isArray(evidence.context) && evidence.context.length > 0 ? h('div', { className: 'eng-row-sub' }, `标签：${evidence.context.join('、')}`) : null,
                      Array.isArray(evidence.dimensions) && evidence.dimensions.length > 0 ? h('div', { className: 'eng-row-sub' }, `维度：${evidence.dimensions.join('、')}`) : null,
                      evidence.lifecycle ? h('div', { className: 'eng-row-sub' }, `生命周期：${evidence.lifecycle.type || ''} ${fmtTime(evidence.lifecycle.at)}`) : null),
                    h('div', { className: 'eng-actions' },
                      h(Button, { small: true, onClick: () => feedback(evidence.id, 'helped') }, '有帮助'),
                      h(Button, { small: true, onClick: () => feedback(evidence.id, 'hurt') }, '没帮上')))
                })))
            : h('div', { key: item.id, className: 'eng-card', style: { padding: 14 } },
                h('div', { className: 'eng-actions', style: { marginBottom: 6 } }, h(Badge, { tone: outcomeOf(item.outcome)[1] }, outcomeOf(item.outcome)[0]), h('span', { className: 'eng-mono' }, `G ${fmtNumber(item.G)}`)),
                h('div', { className: 'eng-row-intent' }, item.intent || '（无意图）'),
                h('div', { className: 'eng-muted', style: { marginTop: 4 } }, item.action || '—')))))))
    }

    const EMPTY_RECORD = { intent: '', action: '', outcome: 'success', type: '', context: '', note: '', taskId: '', kind: 'task', stepIndex: '', stepTotal: '', expectedG: '', expectedOutcome: '', skillId: '', blockedBy: '' }

    function Record() {
      const [form, setForm] = useState(() => {
        try {
          const raw = sessionStorage.getItem('eng:record-draft')
          if (raw !== null) return { ...EMPTY_RECORD, ...JSON.parse(raw) }
        } catch { /* 无 sessionStorage 或坏草稿就从头填 */ }
        return { ...EMPTY_RECORD }
      })
      const [receipt, setReceipt] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        try { sessionStorage.setItem('eng:record-draft', JSON.stringify(form)) } catch { /* 隐私模式忽略 */ }
      }, [form])
      const update = (key) => (event) => setForm({ ...form, [key]: event.target.value })
      const reset = () => {
        setForm({ ...EMPTY_RECORD })
        setReceipt(null)
        setError('')
        try { sessionStorage.removeItem('eng:record-draft') } catch { /* 忽略 */ }
      }
      const stepWarn = form.kind === 'step' && form.stepIndex !== '' && form.stepTotal !== '' && Number(form.stepIndex) > Number(form.stepTotal)
      const submit = async () => {
        if (busy || form.intent.trim() === '' || form.action.trim() === '' || stepWarn) return
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
          try { sessionStorage.removeItem('eng:record-draft') } catch { /* 忽略 */ }
        } catch (caught) {
          setError(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      const group = (title, children, open = false) => h('details', { className: 'eng-form-group', open },
        h('summary', { className: 'eng-form-group-title' }, title),
        h('div', { className: 'eng-form-grid' }, children))
      return h('div', { className: 'eng-fill' },
        h('form', { className: 'eng-card eng-scroll eng-record', onSubmit: (event) => { event.preventDefault(); submit() } },
          error ? h(Banner, { bad: true }, error) : null,
          stepWarn ? h(Banner, { bad: true }, '步骤序号不能大于步骤总数') : null,
          receipt ? h('div', { className: 'eng-receipt' },
            h('div', { className: 'eng-receipt-title' }, '已记录'),
            h('div', { className: 'eng-muted' }, `action=${receipt.action} · id=${receipt.id} · G=${fmtNumber(receipt.G)}${receipt.skillWarning ? ` · ${receipt.skillWarning}` : ''}`),
            h('div', { className: 'eng-actions' }, h(Button, { small: true, onClick: reset }, '再记一条'))) : null,
          group('必填（意图 / 做法 / 结果 / 类型）', [
            h(Field, { key: 'intent', label: '意图（做什么）', wide: true }, h('input', { className: 'eng-input', value: form.intent, onChange: update('intent'), placeholder: '例如：给研学课 PPT 插一页过渡页' })),
            h(Field, { key: 'action', label: '做法', wide: true }, h('input', { className: 'eng-input', value: form.action, onChange: update('action'), placeholder: '可复用的具体做法' })),
            h(Field, { key: 'outcome', label: '结果' }, h('select', { className: 'eng-select', value: form.outcome, onChange: update('outcome') }, Object.keys(OUTCOMES).map((key) => h('option', { key, value: key }, OUTCOMES[key][0])))),
            h(Field, { key: 'type', label: '类型' }, h('input', { className: 'eng-input', value: form.type, onChange: update('type'), placeholder: 'PPT / 课件' })),
            h(Field, { key: 'context', label: '标签（逗号分隔）' }, h('input', { className: 'eng-input', value: form.context, onChange: update('context'), placeholder: '插件, 主题, 性能' })),
          ], true),
          group('任务与步骤（可选，记录多步任务时）', [
            h(Field, { key: 'taskId', label: '任务 id' }, h('input', { className: 'eng-input', value: form.taskId, onChange: update('taskId') })),
            h(Field, { key: 'kind', label: '粒度' }, h('select', { className: 'eng-select', value: form.kind, onChange: update('kind') }, h('option', { value: 'task' }, '整条任务'), h('option', { value: 'step' }, '任务步骤'))),
            h(Field, { key: 'stepIndex', label: '步骤序号（kind=step）' }, h('input', { className: 'eng-input', type: 'number', value: form.stepIndex, onChange: update('stepIndex') })),
            h(Field, { key: 'stepTotal', label: '步骤总数（kind=step）' }, h('input', { className: 'eng-input', type: 'number', value: form.stepTotal, onChange: update('stepTotal') })),
          ]),
          group('预期与技能（可选）', [
            h(Field, { key: 'expectedG', label: '预期 G' }, h('input', { className: 'eng-input', type: 'number', step: '0.05', value: form.expectedG, onChange: update('expectedG'), placeholder: '0.8' })),
            h(Field, { key: 'expectedOutcome', label: '预期结果' }, h('select', { className: 'eng-select', value: form.expectedOutcome, onChange: update('expectedOutcome') }, h('option', { value: '' }, '不设置'), ['accepted','success','partial','unknown','failed','corrected','aborted'].map((key) => h('option', { key, value: key }, OUTCOMES[key] ? OUTCOMES[key][0] : key)))),
            h(Field, { key: 'skillId', label: '技能 id' }, h('input', { className: 'eng-input', value: form.skillId, onChange: update('skillId'), placeholder: 'skill:<slug>' })),
            h(Field, { key: 'blockedBy', label: '受阻描述' }, h('input', { className: 'eng-input', value: form.blockedBy, onChange: update('blockedBy'), placeholder: '页脚错位 第 3 行' })),
          ]),
          group('备注', [
            h(Field, { key: 'note', label: '为什么有效 / 踩了什么坑', wide: true }, h('textarea', { className: 'eng-textarea', value: form.note, onChange: update('note') })),
          ]),
          h('div', { className: 'eng-actions' },
            h(Button, { kind: 'primary', disabled: busy || form.intent.trim() === '' || form.action.trim() === '' || stepWarn, onClick: submit }, busy ? '提交中…' : '记录'),
            h(Button, { disabled: busy, onClick: reset }, '清空草稿'))))
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
        error ? h('div', { className: 'eng-muted eng-bad-text', style: { flexBasis: '100%' } }, error) : null)
    }

    /**
     * 技能页：按 `/skills.tree` 渲染套件抽屉。
     *
     * 结构以服务端目录树为权威（`tree`）；旧响应没有 tree 时用平铺 `skills` 兜底成一层。
     * 展开状态只把「开着的」节点写进 localStorage['eng-suite-open']，默认全收起。
     * 详情与管理动作按节点类型分三种：独立技能 / 根技能（含子技能）/ 组节点（只有子技能）。
     */
    function Skills(props) {
      const skills = useLoad(useCallback(() => request('/skills'), []))
      const validation = useLoad(useCallback(() => request('/validate'), []))
      useRefreshEvent(skills.reload)
      const [selected, setSelected] = useState(null)
      const [intent, setIntent] = useState('')
      const [context, setContext] = useState('')
      const [notice, setNotice] = useState('')
      // 「忘记技能」两步确认：第一下只换文案，第二下才真的删（删除还带 expect=N）
      const [confirmForget, setConfirmForget] = useState('')
      // 套件树展开状态：默认全收起，只记开着的 path
      const [openMap, setOpenMap] = useState(() => readSuiteOpen())
      const [query, setQuery] = useState('')
      const [status, setStatus] = useState('')
      const rows = skills.data ? skills.data.skills || [] : []
      const tree = useMemo(() => normalizeSkillTree(skills.data), [skills.data])
      const current = selected === null ? null : rowAtPath(rows, selected)
      const node = selected === null ? null : treeNodeAt(tree, selected) || (current === null ? null : {
        path: relativePathOf(current),
        name: current.name || relativePathOf(current),
        kind: current.kind === 'group' ? 'group' : 'skill',
        depth: Number(current.depth) || 0,
        skillCount: Number(current.skillCount) || 1,
        registeredCount: current.globalRegistered ? 1 : 0,
        children: [],
      })
      const pathOfCurrent = node === null ? '' : String(node.path || '')
      const kind = node !== null && node.kind === 'group' ? 'group' : 'skill'
      const skillCount = nodeSkillCountOf(node)
      const registeredCount = node === null ? 0 : Number(node.registeredCount) || 0
      const childCount = node === null ? 0 : nodeChildrenOf(node).length
      const isGroup = kind === 'group'
      const isChild = isGroup === false && node !== null && nodeDepthOf(node) > 0
      const isRootSkill = isGroup === false && node !== null && isChild === false && childCount > 0
      const isSimple = isGroup === false && isChild === false && isRootSkill === false
      const allRegistered = skillCount > 0 && registeredCount >= skillCount
      // 只渲染展开路径上的节点：默认收起时就是顶层节点
      const filtering = query.trim() !== '' || status !== ''
      const visible = useMemo(() => {
        if (filtering) {
          const needle = query.trim().toLowerCase()
          return rows
            .filter((row) => {
              if (status !== '' && row.status !== status) return false
              if (needle === '') return true
              const haystack = [row.name, row.description, row.path, row.id, ...(Array.isArray(row.notes) ? row.notes : [])].join(' ').toLowerCase()
              return haystack.includes(needle)
            })
            .map((row) => ({ node: { path: row.path || row.id, name: row.name, kind: 'skill', depth: 0, skillCount: 1, registeredCount: row.globalRegistered ? 1 : 0, children: [] }, depth: 0 }))
        }
        const out = []
        const walk = (nodes, depth) => {
          for (const item of nodes) {
            if (item === null || item === undefined) continue
            out.push({ node: item, depth })
            if (openMap[item.path] === true) walk(nodeChildrenOf(item), depth + 1)
          }
        }
        walk(tree, 0)
        return out
      }, [tree, openMap, filtering, rows, query, status])
      const toggleNode = (path) => {
        setOpenMap((previous) => {
          const next = { ...previous }
          if (next[path] === true) delete next[path]
          else next[path] = true
          writeSuiteOpen(next)
          return next
        })
      }
      // 标签 / 面包屑跳转：选中目标节点，并把它的所有祖先展开
      const jumpTo = (path) => {
        if (path === '' || treeNodeAt(tree, path) === null) return
        setSelected(path)
        setConfirmForget('')
        setOpenMap((previous) => {
          const next = { ...previous }
          for (const prefix of prefixPathsOf(path).slice(0, -1)) next[prefix] = true
          writeSuiteOpen(next)
          return next
        })
      }
      const act = async (fn) => {
        try {
          setNotice(await fn())
          await Promise.all([skills.reload(), validation.reload()])
          props.onChanged()
        } catch (caught) {
          setNotice(caught.message || String(caught))
        }
      }
      /** 子树动作：register / unregister / forget（带 expect）/ detach。 */
      const nodeAction = async (action, expect) => {
        const path = pathOfCurrent
        const leaf = lastSegmentOf(path)
        const body = { path, action }
        if (Number.isFinite(expect)) body.expect = Math.trunc(expect)
        try {
          const out = await request('/skill-node', { method: 'POST', body })
          const total = Number(out && out.total) || 0
          const failed = out && Array.isArray(out.failed) ? out.failed : []
          // forget 的成功数在 deleted 上（没有 ok 字段）；detach 用 moved；register/unregister 用 ok
          const done = out !== null && out !== undefined && out.ok !== undefined
            ? Number(out.ok) || 0
            : action === 'forget'
              ? (out && out.deleted === true ? total : Math.max(0, total - failed.length))
              : (out && out.moved === true ? 1 : 0)
          let message = `已执行 ${action}：成功 ${done}/${total}`
          if (action === 'register') message = `已注册 ${done}/${total} 个技能到全局`
          else if (action === 'unregister') message = `已取消注册 ${done}/${total} 个技能`
          else if (action === 'forget') message = `已删除 ${done} 个技能（共 ${total}）`
          else if (action === 'detach') message = `已移出套件：${(out && out.to) || leaf}（现在是顶层技能）`
          if (failed.length > 0) {
            const details = failed.slice(0, 3).map((item) => `${item.path || '?'}：${item.message || item.error || '未知原因'}`).join('；')
            message += `；失败 ${failed.length} 项：${details}${failed.length > 3 ? ' 等' : ''}`
            if (action === 'register') {
              const occupied = failed.some((item) => /occupied|占用|已存在|exists/iu.test(String(item.message || item.error || '')))
              message += occupied
                ? `。$DSH_HOME/skills/${leaf} 已被占用，未覆盖；请先取消注册或改名`
                : `。目标目录被占用时不会覆盖（$DSH_HOME/skills/${leaf}），可先取消注册或改名`
            }
          }
          setNotice(message)
          setConfirmForget('')
          if (action === 'forget' || action === 'detach') setSelected(null)
          await Promise.all([skills.reload(), validation.reload()])
          props.onChanged()
        } catch (caught) {
          setNotice(caught.message || String(caught))
          setConfirmForget('')
        }
      }
      // 管理动作单独一张卡，压在详情卡上面；按钮按节点类型分组（先于详情构造，保持「管理卡在上」的源码顺序）
      const actionsCard = node === null ? null : h('div', { className: 'eng-card eng-skill-actions' },
        isSimple && current !== null ? [
          h(Button, {
            key: 'simple-register',
            small: true,
            kind: current.globalRegistered ? undefined : 'primary',
            title: current.globalRegistered
              ? '把链接从 DSH skills 目录里删掉，技能回到经验库排序'
              : '链接进 DSH 的 skills 目录：之后由 DSH 当普通技能加载，经验库不再排序它',
            onClick: () => act(async () => {
              const out = await request('/skill-global', { method: 'POST', body: { slug: current.id || pathOfCurrent, action: current.globalRegistered ? 'unregister' : 'register' } })
              return out.registered
                ? `已注册到全局：${out.targetDir}`
                : `已取消注册${out.removed ? '' : '（链接本来就不在了，已清理记录）'}`
            }),
          }, current.globalRegistered ? '取消注册' : '注册技能到全局'),
          h(Button, {
            key: 'simple-forget',
            small: true,
            kind: 'danger',
            title: confirmForget === pathOfCurrent ? '再点一次就删掉这个技能目录' : '从经验库删除这个技能',
            onClick: () => {
              if (confirmForget !== pathOfCurrent) {
                setConfirmForget(pathOfCurrent)
                return
              }
              act(async () => {
                const out = await request('/skill-forget', { method: 'POST', body: { slug: current.id || pathOfCurrent } })
                setConfirmForget('')
                setSelected(null)
                return `已忘记技能：${out.slug}`
              })
            },
          }, confirmForget === pathOfCurrent ? '确认忘记' : '忘记技能'),
        ] : null,
        isRootSkill ? [
          h(Button, {
            key: 'root-register',
            small: true,
            kind: allRegistered ? undefined : 'primary',
            title: '对整个套件（根技能 + 全部子技能）注册到 DSH skills 目录',
            onClick: () => nodeAction(allRegistered ? 'unregister' : 'register'),
          }, allRegistered ? '取消注册（含子技能）' : '注册到全局（含子技能）'),
          h(Button, {
            key: 'root-forget',
            small: true,
            kind: 'danger',
            title: confirmForget === pathOfCurrent ? `再点一次会删除整棵子树（${skillCount} 个技能）` : '连同全部子技能从经验库删除',
            onClick: () => {
              if (confirmForget !== pathOfCurrent) {
                setConfirmForget(pathOfCurrent)
                return
              }
              nodeAction('forget', skillCount)
            },
          }, confirmForget === pathOfCurrent ? `确认删除 ${skillCount} 个技能` : `忘记技能（含 ${Math.max(0, skillCount - 1)} 个子技能）`),
        ] : null,
        isChild ? [
          h(Button, {
            key: 'child-register',
            small: true,
            kind: allRegistered ? undefined : 'primary',
            title: '把这个子技能（含它自己的后代）注册到 DSH skills 目录',
            onClick: () => nodeAction(allRegistered ? 'unregister' : 'register'),
          }, allRegistered ? '取消注册' : '注册到全局'),
          h(Button, {
            key: 'child-forget',
            small: true,
            kind: 'danger',
            title: confirmForget === pathOfCurrent ? '再点一次就删掉这个技能（含后代）' : '从经验库删除这个技能（含后代）',
            onClick: () => {
              if (confirmForget !== pathOfCurrent) {
                setConfirmForget(pathOfCurrent)
                return
              }
              nodeAction('forget', skillCount)
            },
          }, confirmForget === pathOfCurrent ? `确认删除 ${skillCount} 个技能` : '忘记技能'),
          h(Button, {
            key: 'child-detach',
            small: true,
            title: '把子技能移到顶层（技能不删，只解除套件关系）',
            onClick: () => nodeAction('detach'),
          }, '移出套件'),
        ] : null,
        isGroup ? [
          h(Button, {
            key: 'group-register',
            small: true,
            kind: allRegistered ? undefined : 'primary',
            title: `注册整套（${skillCount} 个技能）到 DSH skills 目录`,
            onClick: () => nodeAction(allRegistered ? 'unregister' : 'register'),
          }, allRegistered ? '取消整套' : `注册整套（${skillCount} 个技能）`),
          h(Button, {
            key: 'group-forget',
            small: true,
            kind: 'danger',
            title: confirmForget === pathOfCurrent ? `再点一次会删除整棵子树（${skillCount} 个技能）` : '删除整套（子技能一起删）',
            onClick: () => {
              if (confirmForget !== pathOfCurrent) {
                setConfirmForget(pathOfCurrent)
                return
              }
              nodeAction('forget', skillCount)
            },
          }, confirmForget === pathOfCurrent ? `确认删除 ${skillCount} 个技能` : `忘记整套（${skillCount} 个技能）`),
        ] : null)
      const crumb = pathSegmentsOf(pathOfCurrent).length > 1
        ? h('div', { className: 'eng-crumb' }, pathSegmentsOf(pathOfCurrent).map((segment, index, segments) => {
          const target = segments.slice(0, index + 1).join('/')
          const isLast = index === segments.length - 1
          const clickable = isLast === false && treeNodeAt(tree, target) !== null
          return h('span', { key: target, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            index > 0 ? h('span', { className: 'eng-crumb-sep' }, '/') : null,
            clickable ? h('button', { type: 'button', onClick: () => jumpTo(target) }, segment) : h('span', { 'data-current': isLast ? 'true' : 'false' }, segment))
        }))
        : null
      const detail = node === null
        ? h('div', { className: 'eng-card eng-detail-card' }, h(Empty, null, '选一个技能看正文'))
        : h('div', { className: 'eng-card eng-detail-card' },
          h('div', { className: 'eng-detail' },
            crumb,
            h('h3', { className: 'eng-detail-title' }, node.name || pathOfCurrent),
            isGroup
              ? h('div', null,
                h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, `组节点：${skillCount} 个技能${registeredCount > 0 ? ` · 已注册 ${registeredCount}/${skillCount}` : ''}`),
                h('div', { className: 'eng-muted', style: { marginBottom: 8, fontSize: 12 } }, '这个目录只用于收纳，没有 SKILL.md；注册 / 取消注册 / 忘记都会作用于整棵子树。'))
              : h('div', null,
                h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, current === null ? '（读取中…）' : (current.description || '—')),
                isRootSkill
                  ? h('div', { className: 'eng-muted', style: { marginBottom: 8, fontSize: 12 } }, `套件：${Math.max(0, skillCount - 1)} 个子技能 · 已注册 ${registeredCount}/${skillCount}`)
                  : null,
                isChild
                  ? h('div', { className: 'eng-muted', style: { marginBottom: 8, fontSize: 12 } }, `套件：${rootNameOf(pathOfCurrent)} · 路径 ${pathOfCurrent}`)
                  : null,
                current !== null && Number(current.packageFiles) > 0
                  ? h('div', { className: 'eng-muted', style: { marginBottom: 8, fontSize: 12 } },
                    `整包：${current.packageFiles} 个文件 / ${fmtBytes(current.packageBytes)}${Array.isArray(current.packageDirs) && current.packageDirs.length > 0 ? ` · ${current.packageDirs.join('、')}` : ''}（导入时随 SKILL.md 一起复制）`)
                  : null,
                current === null ? null : h(SkillMetaEditor, { key: current.id || pathOfCurrent, row: current, onSaved: async (message) => { await skills.reload(); props.onChanged(); setNotice(message) } }),
                current === null ? null : h('div', { className: 'eng-actions', style: { marginBottom: 10 } },
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id || pathOfCurrent, result: 'helped' } }); return '已记「有帮助」' }) }, '有帮助'),
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id || pathOfCurrent, result: 'hurt' } }); return '已记「没帮上」' }) }, '没帮上'),
                  h(Button, { small: true, onClick: () => act(async () => { await request('/skill-feedback', { method: 'POST', body: { slug: current.id || pathOfCurrent, result: 'neutral' } }); return '已记「中性」' }) }, '中性')),
                h('div', { className: 'eng-muted', style: { marginBottom: 10, fontSize: 12 } }, isRootSkill || isChild
                  ? (allRegistered
                    ? `已全部注册到全局（${registeredCount}/${skillCount}）：DSH 会把它们当普通技能加载，经验库不再排序/召回。`
                    : `套件内已注册 ${registeredCount}/${skillCount} 个技能；注册 / 取消注册在管理卡里按子树执行。`)
                  : (current !== null && current.globalRegistered
                    ? `已注册到全局（${current.globalPath || 'DSH skills 目录'}）：DSH 会把它当真实技能加载，经验库不再排序/召回它；点「取消注册」回到经验库管理。`
                    : '还没注册到全局：它归经验库自己管，召回时按需以技能形态交给模型；要当普通技能用就点「注册技能到全局」。')),
                current !== null && Array.isArray(current.files) && current.files.length > 0
                  ? h('div', { style: { marginBottom: 10 } }, h('div', { className: 'eng-label', style: { marginBottom: 4 } }, '脚本附件'), current.files.map((file) => h('div', { key: file, className: 'eng-mono eng-muted' }, file)))
                  : null,
                h('pre', { className: 'eng-pre' }, current === null ? '（组节点没有正文）' : (current.body || '（空）')))))
      return h('div', { className: 'eng-fill' },
        skills.error ? h(Banner, { bad: true }, skills.error) : null,
        notice ? h(Banner, null, notice) : null,
        h('div', { className: 'eng-toolbar' },
          h('input', { className: 'eng-input', placeholder: '搜技能名 / 描述 / 路径…', value: query, onChange: (event) => setQuery(event.target.value) }),
          h('select', { className: 'eng-select', style: { width: 130 }, value: status, onChange: (event) => setStatus(event.target.value) },
            h('option', { value: '' }, '全部状态'),
            ['solid', 'trial', 'risky', 'blocked', 'new'].map((key) => h('option', { key, value: key }, SKILL_STATES[key] ? SKILL_STATES[key][0] : key))),
          h('span', { className: 'eng-muted' }, filtering ? `${visible.length} 个匹配` : `共 ${rows.length} 个技能`)),
        h('div', { className: 'eng-split', 'data-open': node === null ? 'false' : 'true' },
          h('div', { className: 'eng-card' },
            visible.length === 0 ? (skills.loading ? h(Skeleton, { rows: 5 }) : skills.error ? h(ErrorState, { message: skills.error, onRetry: skills.reload }) : h(Empty, null, '还没有固化技能：至少 3 条同族经验（含正负对照）后沉淀')) : visible.map(({ node: item, depth }) => {
              const row = rowAtPath(rows, item.path)
              const itemKind = item.kind === 'group' ? 'group' : 'skill'
              const itemCount = nodeSkillCountOf(item)
              const itemRegistered = Number(item.registeredCount) || 0
              const children = nodeChildrenOf(item)
              const isOpen = openMap[item.path] === true
              const itemIsChild = itemKind === 'skill' && nodeDepthOf(item) > 0
              const itemIsRoot = itemKind === 'skill' && itemIsChild === false && children.length > 0
              const [label, tone] = row === null ? ['待验证', 'muted'] : skillStateOf(row.status)
              const suiteTarget = itemIsChild ? suitePathOf(tree, item.path) : ''
              return h('div', {
                key: item.path,
                className: 'eng-skill-row eng-tree-row',
                'data-on': selected === item.path ? 'true' : 'false',
                tabIndex: 0,
                style: { paddingLeft: 8 + depth * 18 },
                onClick: () => { setSelected(item.path); setConfirmForget('') },
                onKeyDown: (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelected(item.path); setConfirmForget('') } },
              },
                children.length > 0
                  ? h('button', {
                    type: 'button',
                    className: 'eng-tree-toggle',
                    title: isOpen ? '收起子技能' : '展开子技能',
                    'aria-label': isOpen ? '收起子技能' : '展开子技能',
                    'aria-expanded': isOpen ? 'true' : 'false',
                    onClick: (event) => { event.stopPropagation(); toggleNode(item.path) },
                  }, isOpen ? '▾' : '▸')
                  : h('span', { className: 'eng-tree-toggle', 'aria-hidden': 'true' }, ''),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { className: 'eng-skill-name', title: row !== null ? (row.description || row.name) : item.path },
                    item.name || lastSegmentOf(item.path),
                    itemKind === 'group'
                      ? h('span', { className: 'eng-suite-tag', 'data-static': 'true' }, `${itemCount} 个技能`)
                      : null,
                    itemIsRoot
                      ? h('button', { type: 'button', className: 'eng-suite-tag', title: isOpen ? '收起子技能' : '展开子技能', onClick: (event) => { event.stopPropagation(); toggleNode(item.path) } }, `套件 · ${Math.max(0, itemCount - 1)} 个子技能`)
                      : null,
                    suiteTarget !== ''
                      ? h('button', { type: 'button', className: 'eng-suite-tag', title: '跳到所属套件', onClick: (event) => { event.stopPropagation(); jumpTo(suiteTarget) } }, `套件：${rootNameOf(item.path)}`)
                      : null),
                  h('div', { className: 'eng-actions', style: { marginTop: 6 } },
                    itemKind === 'skill' && row !== null ? h(Badge, { tone }, label) : null,
                    itemKind === 'skill'
                      ? h('span', { className: 'eng-muted' }, `uses ${row !== null ? row.uses || 0 : 0} · helped ${row !== null ? row.helped || 0 : 0} · hurt ${row !== null ? row.hurt || 0 : 0}`)
                      : h('span', { className: 'eng-muted' }, `已注册 ${itemRegistered}/${itemCount}`),
                    row !== null && row.globalRegistered ? h(Badge, { tone: 'brand' }, '全局') : null,
                    row !== null && row.pendingCommit ? h(Badge, { tone: 'warn' }, '待补提交') : null,
                    itemKind === 'skill'
                      ? h('span', { className: 'eng-muted' }, `文件 ${row !== null ? row.packageFiles || (Array.isArray(row.files) ? row.files.length : 0) : 0}`)
                      : null)),
                h('span', { className: 'eng-mono', style: { flex: '0 0 auto' } }, item.path))
            })),
          h('div', { className: 'eng-stack' },
            h('div', { className: 'eng-card', style: { padding: 15 } },
              h('h3', { className: 'eng-section-title', style: { marginBottom: 8 } }, '沉淀技能'),
              h(Field, { label: '同族意图' }, h('input', { className: 'eng-input', value: intent, onChange: (event) => setIntent(event.target.value), placeholder: '例如：给 PPT 插页' })),
              h(Field, { label: '标签（逗号分隔，可选）' }, h('input', { className: 'eng-input', value: context, onChange: (event) => setContext(event.target.value) })),
              h(Button, { kind: 'primary', disabled: intent.trim() === '', onClick: () => act(async () => { const out = await request('/consolidate', { method: 'POST', body: { intent, context: context.trim() === '' ? [] : context.split(/[,，]/).map((item) => item.trim()).filter(Boolean) } }); return `沉淀结果：${out.action}${out.slug ? `（${out.slug}）` : ''}` }) }, '沉淀')),
            h('div', { className: 'eng-card', style: { padding: 15 } },
              h('h3', { className: 'eng-section-title', style: { marginBottom: 8 } }, '技能校验'),
              validation.data && validation.data.problems && validation.data.problems.length > 0
                ? validation.data.problems.map((item) => h('div', { key: item.slug, className: 'eng-muted', style: { marginBottom: 6 } }, `${item.slug}：${item.problems.join('；')}`))
                : h('div', { className: 'eng-muted' }, '全部健康')),
            actionsCard,
            detail)))
    }

    /**
     * 在拖进来的文件夹里收集所有 SKILL.md（浏览器只有 FileSystemEntry，没有路径）。
     * 每个结果带 `fullPath`，用来还原 `<根目录>/<子目录>/SKILL.md` 的套件层级。
     * 深度限制 8 层、最多 60 个，避免用户把整个盘拖进来卡死。
     */
    async function collectSkillEntries(entry, depth, out) {
      if (entry === null || entry === undefined || depth > 8 || out.length >= 60) return
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)))
        if (file && /^skill\.md$/iu.test(file.name)) out.push({ file, fullPath: String(entry.fullPath || '') })
        return
      }
      if (!entry.isDirectory) return
      const reader = entry.createReader()
      const readBatch = () => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
      let batch = await readBatch()
      while (batch.length > 0 && out.length < 60) {
        for (const child of batch) {
          await collectSkillEntries(child, depth + 1, out)
          if (out.length >= 60) break
        }
        batch = await readBatch()
      }
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
    /**
     * 推送时发现远端有本机没有的提交：三种处置交给用户决定。
     * 复用 eng-modal 那套样式，不新造弹窗皮肤。
     */
    function PushConflictDialog(props) {
      const modalRef = useRef(null)
      useModalFocus(modalRef, props.onClose, true)
      const conflict = props.conflict || {}
      const ahead = Number(conflict.remoteAhead) > 0 ? Number(conflict.remoteAhead) : 1
      return h('div', { className: 'eng-modal-mask', role: 'dialog', 'aria-modal': 'true', 'aria-label': '推送前确认' },
        h('div', { className: 'eng-modal', ref: modalRef, style: { width: 'min(520px, 100%)' } },
          h('h3', { className: 'eng-modal-title' }, '远端有本机没有的提交'),
          h('div', { className: 'eng-muted', style: { lineHeight: 1.8, marginTop: 6 } },
            `这个仓库比本机多 ${ahead} 个提交（分支 ${conflict.branch || '—'}）。要继续推送，先选一种处置：`),
          h('ul', { className: 'eng-req', style: { marginTop: 10 } },
            h('li', null, h('b', null, '覆盖远端'), '：用本机内容强推。覆盖前会把旧远端 HEAD 存进本地的 refs/engram/overwritten/*，需要时能捞回来。'),
            h('li', null, h('b', null, '换远端仓库'), '：不动这个仓库，改成推到另一个仓库。'),
            h('li', null, h('b', null, '另建分支'), '：推到新分支上，原分支保持原样；之后的备份默认走新分支。')),
          h('div', { className: 'eng-modal-actions', style: { flexWrap: 'wrap' } },
            h(Button, { small: true, onClick: props.onClose }, '取消'),
            h(Button, { small: true, disabled: props.busy, onClick: props.onNewBranch }, '另建分支'),
            h(Button, { small: true, disabled: props.busy, onClick: props.onSwitchRepo }, '换远端仓库'),
            h(Button, { small: true, kind: 'primary', disabled: props.busy, onClick: props.onOverwrite }, '覆盖远端'))))
    }

    function ImportSkillDialog(props) {
      const [content, setContent] = useState('')
      const [fileName, setFileName] = useState('')
      const [dragging, setDragging] = useState(false)
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [sourcePath, setSourcePath] = useState('')
      const [categoriesDraft, setCategoriesDraft] = useState('')
      const [notesDraft, setNotesDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const fileInputRef = useRef(null)
      const dirInputRef = useRef(null)
      const modalRef = useRef(null)
      // 浏览器选文件夹时一次可能读到多个 SKILL.md（套件），先攒起来再一次性提交
      const [contentsDraft, setContentsDraft] = useState([])
      // 套件的根目录名（来自 webkitRelativePath / 拖拽目录名）与可改的套件名
      const [suiteRoot, setSuiteRoot] = useState('')
      const [suiteName, setSuiteName] = useState('')
      // 套件批量导入进度：{ total, done, current }；非空时弹窗整体切成进度条视图
      const [progress, setProgress] = useState(null)
      useModalFocus(modalRef, props.onClose, progress === null)
      const canSubmit = busy === false && (sourcePath.trim() !== '' || content.trim() !== '' || contentsDraft.length > 0)
      // 从 SKILL.md frontmatter 取名字，用于进度条显示
      const nameOfSkill = (text) => {
        const matched = /^---[\s\S]*?\nname:\s*(.+)$/mu.exec(String(text || ""))
        return matched === null ? '未命名技能' : matched[1].trim().replace(/^['"]|['"]$/gu, '')
      }
      const readTextOf = async (file) => {
        try {
          const text = await file.text()
          return String(text || '').trim() === '' ? '' : text
        } catch {
          return ''
        }
      }
      /** webkitRelativePath：`套件/子技能/SKILL.md` → { root:'套件', relPath:'子技能' }。 */
      const relPartsOf = (relative) => {
        const segments = String(relative || '').split(/[\\/]/u).filter((segment) => segment !== '')
        if (segments.length <= 1) return { root: '', relPath: '' }
        return { root: segments[0], relPath: segments.slice(1, -1).join('/') }
      }
      /** 套件草稿：根目录名只认首次出现的那个；套件名可被输入框改掉。 */
      const applySuiteDraft = (items) => {
        const roots = Array.from(new Set(items.map((item) => item.root).filter((root) => root !== '')))
        setContentsDraft(items)
        setSuiteRoot(roots.length === 1 ? roots[0] : '')
        setSuiteName(roots.length === 1 ? roots[0] : '')
        setContent('')
        setSourcePath('')
        setFileName(`${items.length} 个技能（套件）`)
        setError('')
      }
      const draftFromFiles = async (skillDocs) => {
        const items = []
        for (const file of skillDocs.slice(0, 30)) {
          const text = await readTextOf(file)
          if (text === '') continue
          const located = relPartsOf(file.webkitRelativePath)
          items.push({ name: nameOfSkill(text), text, root: located.root, relPath: located.relPath })
        }
        return items
      }
      const suiteRootForItem = (item) => {
        if (item === null || item === undefined || item.root === '') return ''
        // 单根时允许用输入框改名；多根（一次拖多个文件夹）时各用各的根名，避免被合并
        if (suiteName.trim() !== '' && suiteRoot !== '') return suiteName.trim()
        return item.root
      }
      const pathForItem = (item) => {
        const root = suiteRootForItem(item)
        if (root === '') return ''
        return item.relPath === '' ? root : `${root}/${item.relPath}`
      }
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
          setContentsDraft([])
          setSuiteRoot('')
          setSuiteName('')
          setError('')
        } catch (caught) {
          setError(`读取失败：${caught && caught.message ? caught.message : String(caught)}`)
        }
      }
      /** 从拖放里尽量抠出本地绝对路径：宿主拦截了 File 对象时，uri-list / text 里往往还留着 file:// 路径。 */
      const droppedPathOf = (event) => {
        const dt = event && event.dataTransfer
        if (!dt || typeof dt.getData !== 'function') return ''
        let raw = ''
        try {
          raw = dt.getData('text/uri-list') || dt.getData('text/plain') || ''
        } catch {
          raw = ''
        }
        const first = String(raw || '').split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '') || ''
        if (/^file:\/\//iu.test(first)) {
          try {
            return decodeURIComponent(first.replace(/^file:\/\/\/?/iu, ''))
          } catch {
            return ''
          }
        }
        return /^[A-Za-z]:[\\/]/u.test(first) ? first : ''
      }
      const onDrop = async (event) => {
        event.preventDefault()
        setDragging(false)
        // 1) 能拿到路径就先填路径：服务端直读最稳，不依赖宿主是否肯给 File
        const droppedPath = droppedPathOf(event)
        if (droppedPath !== '') {
          setSourcePath(droppedPath)
          setContent('')
          setFileName('')
          setContentsDraft([])
          setSuiteRoot('')
          setSuiteName('')
          setError('')
          return
        }
        const items = (event.dataTransfer && event.dataTransfer.items) || []
        const files = []
        const dirs = []
        for (const item of items) {
          if (item === null || item.kind !== 'file') continue
          const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
          if (entry !== null && entry !== undefined && entry.isDirectory) {
            dirs.push({ entry, name: String(entry.name || '') })
            continue
          }
          const file = item.getAsFile()
          if (file !== null) files.push(file)
        }
        // 拖进来的是文件夹：沿 FileSystemEntry 收集所有 SKILL.md，按目录层级还原套件
        if (dirs.length > 0) {
          const collected = []
          for (const dir of dirs) {
            const found = []
            await collectSkillEntries(dir.entry, 0, found)
            for (const one of found) {
              const text = await readTextOf(one.file)
              if (text === '') continue
              const segments = String(one.fullPath || '').split('/').filter((segment) => segment !== '')
              // fullPath 形如 /套件/子技能/SKILL.md：去掉根目录名与文件名
              const relPath = segments.slice(1, -1).join('/')
              collected.push({ name: nameOfSkill(text), text, root: dir.name, relPath })
            }
          }
          if (collected.length > 1) {
            applySuiteDraft(collected)
            return
          }
          if (collected.length === 1) {
            setContent(collected[0].text)
            setFileName('SKILL.md')
            setSourcePath('')
            setContentsDraft([])
            setSuiteRoot('')
            setSuiteName('')
            setError('')
            return
          }
        }
        // 2) items 为空时退回 dataTransfer.files
        const fallback = Array.from((event.dataTransfer && event.dataTransfer.files) || [])
        const all = files.length > 0 ? files : fallback
        const picked = all.find((file) => /^skill\.md$/iu.test(file.name)) || all.find((file) => /\.md$/iu.test(file.name)) || all[0]
        if (picked === undefined) setError('没读到文件：在下面「来源路径」粘上绝对路径也能导入（服务端直接读）')
        else await takeFile(picked)
      }
      const onPicked = async (event) => {
        const list = Array.from((event.target && event.target.files) || [])
        if (event.target) event.target.value = ''
        if (list.length === 0) return
        // 文件夹里可能是一个技能（1 个 SKILL.md），也可能是套件（多个子目录各带 SKILL.md）
        const skillDocs = list.filter((file) => /^skill\.md$/iu.test(file.name))
        if (skillDocs.length > 1) {
          const items = await draftFromFiles(skillDocs)
          if (items.length > 1) {
            applySuiteDraft(items)
            return
          }
        }
        setContentsDraft([])
        setSuiteRoot('')
        setSuiteName('')
        const picked = skillDocs[0] || list.find((file) => /\.md$/iu.test(file.name)) || list[0]
        if (picked !== undefined) await takeFile(picked)
      }
      const submit = async () => {
        setBusy(true)
        setError('')
        setResult(null)
        const splitList = (text) => String(text || '').split(/[,，\n]/u).map((item) => item.trim()).filter((item) => item !== '')
        const categories = splitList(categoriesDraft)
        const notes = splitList(notesDraft)
        const batch = sourcePath.trim() === '' && contentsDraft.length > 1 ? contentsDraft : null
        try {
          if (batch !== null) {
          const agg = { suite: true, count: 0, items: [] }
          const rows = batch.map((item) => ({ name: item.name, path: pathForItem(item), state: "waiting", category: "", tags: [], error: "", model: "", classifier: "", note: "", skipped: 0 }))
          // 逐个导入：进度条前进一格，同时把该技能的分类结果写进下面的列表
          for (let index = 0; index < batch.length; index += 1) {
            rows[index].state = "running"
            setProgress({ total: batch.length, done: index, current: rows[index].name, rows: rows.map((row) => ({ ...row })) })
            try {
              const rootNameForItem = suiteRootForItem(batch[index])
              // 同时带两种形状：顶层 content+suiteRoot+relPath（接口契约），以及内核当前消费的
              // contents:[{text,suiteRoot,relPath}]——两边谁先落地都能按目录结构写入。
              const one = await request('/skills/import', { method: 'POST', body: { content: batch[index].text, categories, notes, suiteRoot: rootNameForItem === '' ? undefined : rootNameForItem, relPath: rootNameForItem === '' ? undefined : batch[index].relPath, contents: rootNameForItem === '' ? undefined : [{ text: batch[index].text, suiteRoot: rootNameForItem, relPath: batch[index].relPath }] } })
              const item = (one.items || [])[0] || {}
              rows[index].state = "done"
              rows[index].category = String(item.category || "")
              rows[index].tags = Array.isArray(item.tags) ? item.tags.slice(0, 3) : []
              rows[index].model = String(item.model || "")
              rows[index].classifier = String(item.classifier || "")
              rows[index].note = String(item.note || "")
              rows[index].skipped = item.package ? Number(item.package.skipped) || 0 : 0
              agg.count += Number(one.count) || 1
              agg.items.push(...(one.items || []))
            } catch (caught) {
              rows[index].state = "failed"
              rows[index].error = caught.message || String(caught)
              agg.items.push({ action: 'failed', name: rows[index].name, path: rows[index].path, error: rows[index].error })
            }
            setProgress({ total: batch.length, done: index + 1, current: index + 1 < batch.length ? rows[index + 1].name : "", rows: rows.map((row) => ({ ...row })) })
          }            setProgress(null)
            setResult(agg)
            props.onImported(agg)
            return
          }
          const body = sourcePath.trim() !== '' ? { path: sourcePath.trim() } : { content }
          body.categories = categories
          body.notes = notes
          const out = await request('/skills/import', { method: 'POST', body })
          setResult(out)
          props.onImported(out)
        } catch (caught) {
          setError(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }

      // 批量导入时：表单换成「进度条 + 逐行状态 + 临时会话」——分类用的那个会话流式显示
      if (progress !== null) {
        const percent = Math.round((progress.done / Math.max(1, progress.total)) * 100)
        const rows = progress.rows || []
        const model = (rows.find((row) => row.model !== '') || {}).model || '分类会话'
        const stateLabel = (state) => state === 'done' ? '已导入' : state === 'failed' ? '失败' : state === 'running' ? '导入中' : '等待'
        const messages = [{ role: 'system', text: `临时会话已启动 · ${model} · 共 ${progress.total} 个技能` }]
        for (const row of rows) {
          if (row.state === 'waiting') continue
          messages.push({ role: 'user', text: `分类：${row.name}${row.path ? `（${row.path}）` : ''}` })
          if (row.state === 'failed') messages.push({ role: 'assistant', text: `失败：${row.error}`, bad: true })
          else if (row.state === 'done') messages.push({ role: 'assistant', text: `${row.category === '' ? '未分类' : row.category}${row.tags.length > 0 ? ' · ' + row.tags.join(' / ') : ''}${row.classifier === 'local' ? '（本地关键词兜底）' : ''}${row.skipped > 0 ? ` · 跳过 ${row.skipped} 个文件` : ''}` })
          else messages.push({ role: 'assistant', text: '处理中…' })
        }
        return h('div', { className: 'eng-modal-mask', role: 'dialog', 'aria-modal': 'true', 'aria-label': '正在导入技能' },
          h('div', { className: 'eng-modal', ref: modalRef },
            h('h3', { className: 'eng-modal-title' }, '正在导入技能'),
            h('div', { className: 'eng-progress-text' }, progress.current === '' ? `已完成 ${progress.done}/${progress.total}` : `正在导入 ${Math.min(progress.done + 1, progress.total)}/${progress.total}：${progress.current}`),
            h('div', { className: 'eng-progress-track' }, h('div', { className: 'eng-progress-bar', style: { width: `${percent}%` } })),
            h('div', { className: 'eng-progress-list' }, rows.map((row, index) => h('div', { className: 'eng-progress-item', 'data-state': row.state, key: index },
              h('span', { className: 'eng-progress-dot' }),
              h('span', { className: 'eng-progress-name', title: row.path || row.name }, row.path || row.name),
              h('span', { className: 'eng-progress-state' }, stateLabel(row.state)),
              row.classifier === '' ? null : h('span', { className: 'eng-progress-tag eng-progress-tag-soft', title: row.note || '' }, row.classifier === 'session' ? '模型会话' : row.classifier === 'local' ? '本地关键词' : row.classifier),
              row.category === '' ? null : h('span', { className: 'eng-progress-tag' }, row.category),
              row.tags.length === 0 ? null : h('span', { className: 'eng-progress-tag eng-progress-tag-soft' }, row.tags.join(' / ')),
              row.skipped > 0 ? h('span', { className: 'eng-progress-error eng-warn-text' }, `跳过 ${row.skipped} 个文件`) : null,
              row.error === '' ? null : h('span', { className: 'eng-progress-error eng-bad-text' }, row.error)))),
            h('div', { className: 'eng-session' }, messages.map((message, index) => h('div', { className: 'eng-session-msg', 'data-role': message.role, 'data-bad': message.bad ? 'true' : 'false', key: index },
              h('span', { className: 'eng-session-role' }, message.role === 'user' ? '分类请求' : message.role === 'system' ? '会话' : '分类会话'),
              h('span', { className: 'eng-session-text' }, message.text))))))
      }
      return h('div', { className: 'eng-modal-mask', role: 'dialog', 'aria-modal': 'true', 'aria-label': '添加技能' },
        h('div', { className: 'eng-modal', ref: modalRef },
          h('h3', { className: 'eng-modal-title' }, '添加技能'),
          h('div', { className: 'eng-dropzone', 'data-dragging': dragging ? 'true' : 'false', role: 'button', tabIndex: 0, 'aria-label': '拖入技能文件夹或 SKILL.md', title: '拖入技能文件夹或 SKILL.md', onClick: () => { if (fileInputRef.current) fileInputRef.current.click() }, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (fileInputRef.current) fileInputRef.current.click() } }, onDragOver: (event) => { event.preventDefault(); setDragging(true) }, onDragLeave: () => setDragging(false), onDrop: onDrop },
            h('div', { className: 'eng-dropzone-title' }, '拖拽技能到此处'),
            h('div', { className: 'eng-dropzone-actions' },
              h('button', { type: 'button', className: 'eng-dropzone-link', onClick: (event) => { event.stopPropagation(); if (dirInputRef.current) dirInputRef.current.click() } }, '选择文件夹'),
              h('span', { className: 'eng-muted' }, '/'),
              h('button', { type: 'button', className: 'eng-dropzone-link', onClick: (event) => { event.stopPropagation(); if (fileInputRef.current) fileInputRef.current.click() } }, '选择文件')),
            fileName === '' ? null : h('div', { className: 'eng-dropzone-file' }, `已选择：${fileName}`)),
          h('input', { ref: fileInputRef, type: 'file', accept: '.md,.markdown,text/markdown', style: { display: 'none' }, onChange: onPicked }),
          h('input', { ref: dirInputRef, type: 'file', webkitdirectory: '', directory: '', multiple: true, style: { display: 'none' }, onChange: onPicked }),
          h('input', { className: 'eng-input', style: { marginTop: 10 }, autoFocus: true, value: sourcePath, onKeyDown: (event) => { if (event.key === 'Enter' && canSubmit && !busy) submit() }, placeholder: '或粘贴来源路径：C:\\Users\\you\\my-skill（最稳，服务端直接读）', onChange: (event) => setSourcePath(event.target.value) }),
          contentsDraft.length > 1 && suiteRoot !== ''
            ? h('div', { className: 'eng-fixed-target', style: { marginTop: 8 } },
              h('span', { className: 'eng-muted' }, '套件名'),
              h('input', { className: 'eng-input', style: { width: 200 }, value: suiteName, placeholder: suiteRoot, onChange: (event) => setSuiteName(event.target.value) }),
              h('span', { className: 'eng-muted' }, `→ skills/${suiteName.trim() === '' ? suiteRoot : suiteName.trim()}/…`))
            : null,
          h('div', { className: 'eng-muted', style: { marginTop: 6, fontSize: 12 } }, '文件夹需含 SKILL.md；套件按目录结构导入（保留子目录，套件名可改）；整包复制（跳过 .git/node_modules 等，超限文件记 skipped）；导入会用一次模型调用做分类，没有模型服务时退回本地关键词并如实标注。'),
          showAdvanced
            ? h('div', null,
              h('input', { className: 'eng-input', style: { marginTop: 8 }, value: categoriesDraft, placeholder: '分类（逗号分隔，可多个）', onChange: (event) => setCategoriesDraft(event.target.value) }),
              h('input', { className: 'eng-input', style: { marginTop: 8 }, value: notesDraft, placeholder: '便签（逗号分隔，可多条）', onChange: (event) => setNotesDraft(event.target.value) }),
              h('textarea', { className: 'eng-textarea', rows: 6, style: { marginTop: 8 }, value: content, onChange: (event) => { setContent(event.target.value); setFileName(''); setSourcePath('') }, placeholder: '或者直接粘贴 SKILL.md 正文' }))
            : null,
          error ? h(Banner, { bad: true }, error) : null,
          h('div', { className: 'eng-modal-actions' },
            h('button', { type: 'button', className: 'eng-dropzone-link', style: { marginRight: 'auto', alignSelf: 'center' }, onClick: () => setShowAdvanced(!showAdvanced) }, showAdvanced ? '收起高级' : '高级：分类 / 便签 / 粘贴正文'),
            h(Button, { small: true, onClick: props.onClose }, '取消'),
            h(Button, { small: true, kind: 'primary', disabled: !canSubmit, onClick: submit }, busy ? '导入中…' : '安装'))))

    }

    function Types(props) {
      const types = useLoad(useCallback(() => request('/types'), []))
      useRefreshEvent(types.reload)
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [notice, setNotice] = useState('')
      const [selected, setSelected] = useState('')
      const [newName, setNewName] = useState('')
      const [mergeInto, setMergeInto] = useState('')
      const rows = types.data ? types.data.types || [] : []
      const current = rows.find((row) => row.id === selected) || null
      const closeManagement = () => { setSelected(''); setNewName(''); setMergeInto('') }
      const mergeTarget = mergeInto === '' ? null : rows.find((row) => row.name === mergeInto) || null
      const totalCount = rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0)
      const distRows = rows.filter((row) => !row.system && (Number(row.count) || 0) > 0).sort((left, right) => (Number(right.count) || 0) - (Number(left.count) || 0)).slice(0, 8)
      const distMax = Math.max(1, ...distRows.map((row) => Number(row.count) || 0))
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
        h('div', { className: 'eng-card eng-section-card', style: { marginBottom: 14 } },
          h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, '类型分布'), h('span', { className: 'eng-muted' }, `${totalCount} 条可见经验`)),
          distRows.length === 0 ? h(Empty, null, '还没有类型数据') : h('div', { className: 'eng-dist' }, distRows.map((row) => h('div', { key: row.id, className: 'eng-dist-row' },
            h('span', { className: 'eng-row-intent', title: row.name }, row.name),
            h('div', { className: 'eng-dist-track' }, h('div', { className: 'eng-dist-fill', style: { width: `${Math.round(((Number(row.count) || 0) / distMax) * 100)}%` } })),
            h('span', { className: 'eng-mono', style: { textAlign: 'right' } }, String(row.count || 0)))))),
        h('div', { className: 'eng-card eng-scroll' },
          rows.length === 0
            ? (types.loading ? h(Skeleton, { rows: 5 }) : types.error ? h(ErrorState, { message: types.error, onRetry: types.reload }) : h(Empty, null, '还没有类型'))
            : h('table', { className: 'eng-table' },
            h('thead', null, h('tr', null, h('th', null, '名称'), h('th', null, 'id'), h('th', null, '条数'), h('th', null, '类型'))),
            h('tbody', null, rows.map((row) => h('tr', { key: row.id, tabIndex: row.system ? -1 : 0, style: { cursor: row.system ? 'default' : 'pointer' }, onClick: () => { if (!row.system) { if (selected === row.id) closeManagement(); else { setSelected(row.id); setNewName(row.name); setMergeInto('') } } }, onKeyDown: (event) => { if (row.system) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (selected === row.id) closeManagement(); else { setSelected(row.id); setNewName(row.name); setMergeInto('') } } } },
              h('td', null, row.name),
              h('td', { className: 'eng-mono' }, row.id),
              h('td', null, String(row.count || 0)),
              h('td', null, row.system ? h('span', { className: 'eng-muted' }, '系统') : (selected === row.id ? h(Badge, { tone: 'brand' }, '管理中') : h('span', { className: 'eng-muted' }, '点击管理')))))))),
        current === null ? null : h('div', { className: 'eng-card eng-detail', style: { marginTop: 14 } },
          h('h3', { className: 'eng-detail-title' }, `管理：${current.name}`),
          h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, '单条经验改挂类型：到「经验」页 → 详情 → 改挂类型（类型页没有经验列表，不在这里重选）。'),
          mergeTarget === null ? null : h('div', { className: 'eng-muted', style: { marginBottom: 8 } },
            `合并后：${current.name}（${current.count || 0} 条）+ ${mergeTarget.name}（${mergeTarget.count || 0} 条）→ ${mergeInto}（${(Number(current.count) || 0) + (Number(mergeTarget.count) || 0)} 条）；源类型「${current.name}」会删除。`),
          h('div', { className: 'eng-form-grid' },
            h(Field, { label: '新名称' }, h('input', { className: 'eng-input', value: newName, onChange: (event) => setNewName(event.target.value) })),
            h(Field, { label: '合并到' }, h('select', { className: 'eng-select', value: mergeInto, onChange: (event) => setMergeInto(event.target.value) },
              h('option', { value: '' }, '选择目标类型'),
              rows.filter((row) => row.id !== current.id && !row.system).map((row) => h('option', { key: row.id, value: row.name }, row.name))))),
          h('div', { className: 'eng-actions' },
            h(Button, { small: true, disabled: newName.trim() === '', onClick: () => op({ action: 'rename', name: current.name, newName: newName.trim() }) }, '改名'),
            h(Button, { small: true, disabled: mergeInto === '', onClick: () => op({ action: 'merge', names: [current.name, mergeInto], newName: mergeInto }) }, '合并'),
            h(Button, { small: true, kind: 'danger', onClick: () => op({ action: 'delete', name: current.name }) }, '删除'),
            h(Button, { small: true, onClick: closeManagement }, '收起管理'))))
    }

    function Usage() {
      const usage = useLoad(useCallback(() => request('/usage?limit=200'), []))
      const pending = useLoad(useCallback(() => request('/pending'), []))
      const summary = useLoad(useCallback(() => request('/usage-summary'), []))
      useRefreshEvent(useCallback(() => { usage.reload(); pending.reload(); summary.reload() }, [usage.reload, pending.reload, summary.reload]))
      const [openRow, setOpenRow] = useState(-1)
      const [tool, setTool] = useState('')
      const rows = usage.data ? usage.data.rows || [] : []
      const pendingRows = Array.isArray(pending.data) ? pending.data : []
      const stat = summary.data || { calls: 0, chars: 0, avgChars: 0, withChars: 0, byTool: {} }
      const byTool = stat.byTool || {}
      const toolRows = Object.entries(byTool).sort((left, right) => (Number(right[1]) || 0) - (Number(left[1]) || 0))
      const toolMax = Math.max(1, ...toolRows.map(([, count]) => Number(count) || 0))
      const byDay = (() => {
        const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        const map = new Map()
        const now = new Date()
        for (let back = 6; back >= 0; back -= 1) {
          const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
          map.set(dayKey(date), { date: dayKey(date), count: 0, chars: 0 })
        }
        for (const row of rows) {
          const at = new Date(String(row.at || ''))
          if (Number.isNaN(at.getTime())) continue
          const bucket = map.get(dayKey(at))
          if (bucket === undefined) continue
          bucket.count += 1
          bucket.chars += Number(row.chars) || 0
        }
        return [...map.values()]
      })()
      const visibleRows = tool === '' ? rows : rows.filter((row) => row.tool === tool)
      const backfill = async (row, outcome) => {
        await request('/verdicts', { method: 'POST', body: { verdicts: [{ id: row.id, outcome }] } })
        await Promise.all([pending.reload(), summary.reload(), usage.reload()])
      }
      const error = usage.error || pending.error || summary.error
      const kpis = [['调用次数', stat.calls, '次'], ['回执字符', stat.chars, ''], ['平均每次', stat.avgChars, '字'], ['有字符统计', `${stat.withChars || 0}/${stat.calls || 0}`, '']]
      return h('div', { className: 'eng-fill' },
        error ? h(Banner, { bad: true }, error) : null,
        h('div', { className: 'eng-grid' }, kpis.map(([label, value, unit]) => h('div', { key: label, className: 'eng-card eng-kpi' },
          h('span', { className: 'eng-kpi-label' }, label),
          h('span', { className: 'eng-kpi-value' }, h(Metric, { value }), h('span', { className: 'eng-kpi-unit' }, unit))))),
        h('div', { className: 'eng-cols eng-section' },
          h('div', { className: 'eng-card eng-section-card' },
            h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, '最近 7 天调用'), h('span', { className: 'eng-muted' }, `最近 ${stat.calls || 0} 次`)),
            h(Sparkline, { points: byDay, label: '最近 7 天调用次数' })),
          h('div', { className: 'eng-card eng-section-card' },
            h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, '按工具分布')),
            toolRows.length === 0 ? h(Empty, null, '暂无调用') : h('div', { className: 'eng-dist' }, toolRows.map(([name, count]) => h('div', { key: name, className: 'eng-dist-row' },
              h('span', { className: 'eng-row-intent', title: name }, name),
              h('div', { className: 'eng-dist-track' }, h('div', { className: 'eng-dist-fill', style: { width: `${Math.round(((Number(count) || 0) / toolMax) * 100)}%` } })),
              h('span', { className: 'eng-mono', style: { textAlign: 'right' } }, String(count))))))),
        h('div', { className: 'eng-card eng-section-card eng-section' },
          h('div', { className: 'eng-section-head' }, h('h3', { className: 'eng-section-title' }, `待判定（${pendingRows.length}）`)),
          pendingRows.length === 0
            ? h('div', { className: 'eng-muted' }, pending.loading ? '读取中…' : '没有待判定的记录')
            : h('div', { className: 'eng-stack' }, pendingRows.map((row) => h('div', { key: row.id, className: 'eng-pending-row' },
              h('span', { className: 'eng-mono' }, row.id),
              h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || row.action || '—'), row.brief ? h('div', { className: 'eng-row-sub' }, row.brief) : null),
              h('div', { className: 'eng-actions' },
                h(Button, { small: true, onClick: () => backfill(row, 'success') }, '成功'),
                h(Button, { small: true, onClick: () => backfill(row, 'corrected') }, '纠正'),
                h(Button, { small: true, onClick: () => backfill(row, 'failed') }, '失败')))))),
        h('div', { className: 'eng-card eng-scroll eng-section' },
          h('div', { className: 'eng-toolbar', style: { padding: 'var(--eng-s-3)' } },
            h('select', { className: 'eng-select', style: { width: 160 }, value: tool, onChange: (event) => { setTool(event.target.value); setOpenRow(-1) } },
              h('option', { value: '' }, '全部工具'),
              toolRows.map(([name]) => h('option', { key: name, value: name }, name))),
            h('span', { className: 'eng-muted' }, `${visibleRows.length} 条`)),
          visibleRows.length === 0
            ? (usage.loading ? h(Skeleton, { rows: 6 }) : usage.error ? h(ErrorState, { message: usage.error, onRetry: usage.reload }) : h(Empty, null, '还没有调用记录'))
            : h('table', { className: 'eng-table' },
              h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '工具'), h('th', null, '意图'), h('th', null, '字符'), h('th', null, '结果'))),
              h('tbody', null, visibleRows.map((row, index) => [
                  h('tr', { key: `r${index}`, tabIndex: 0, style: { cursor: 'pointer' }, onClick: () => setOpenRow(openRow === index ? -1 : index), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenRow(openRow === index ? -1 : index) } } },
                  h('td', { className: 'eng-mono' }, fmtTime(row.at)),
                  h('td', null, row.tool || '—'),
                  h('td', null, row.intent || row.action || '—'),
                  h('td', { className: 'eng-mono' }, row.chars === undefined || row.chars === null ? '—' : String(row.chars)),
                  h('td', null, row.feedback || (row.ok === false ? '失败' : 'ok'))),
                openRow === index ? h('tr', { key: `d${index}` },
                  h('td', { colSpan: 5, className: 'eng-muted', style: { padding: '8px 12px', fontSize: 11 } },
                    `op=${row.op || '—'} · limit=${row.limit === null || row.limit === undefined ? '—' : row.limit}`
                    + ` · routeScore=${row.routeScore === null || row.routeScore === undefined ? '—' : fmtNumber(row.routeScore)}`
                    + ` · ids=${Array.isArray(row.ids) && row.ids.length > 0 ? row.ids.join(', ') : '—'}`
                    + (row.error ? ` · 错误：${row.error}` : ''))) : null])))))
    }

    /**
     * 冷档（0.14 P2）：容量安全阀下沉的老经验，只读。
     * 数据来自 GET /cold；不做反馈/编辑，避免把只读子集写回整库。
     */
    function Cold() {
      const limit = 50
      const [draft, setDraft] = useState('')
      const [query, setQuery] = useState('')
      const [year, setYear] = useState('')
      const [page, setPage] = useState(0)
      const [selected, setSelected] = useState(null)
      const list = useLoad(useCallback(() => {
        const params = new URLSearchParams({ offset: String(page * limit), limit: String(limit) })
        if (query !== '') params.set('query', query)
        if (year !== '') params.set('year', year)
        return request(`/cold?${params.toString()}`)
      }, [page, query, year]))
      useRefreshEvent(list.reload)
      useEffect(() => { setPage(0) }, [query, year])
      const data = list.data || {}
      const rows = Array.isArray(data.rows) ? data.rows : []
      const years = Array.isArray(data.years) ? data.years : []
      const total = Number(data.total) || 0
      const pages = Math.max(1, Math.ceil(total / limit))
      const current = selected === null ? null : rows.find((row) => row.id === selected) || null
      const submit = () => { setQuery(draft.trim()); setPage(0) }
      return h('div', { className: 'eng-fill' },
        list.error ? h(Banner, { bad: true }, list.error) : null,
        data.error ? h(Banner, { bad: true }, `冷档读取失败：${data.error}`) : null,
        h(Banner, null, '冷档只读：容量安全阀触发后下沉的老经验，默认不参与召回；这里只查，不写回整库。'),
        h('div', { className: 'eng-toolbar' },
          h('input', {
            className: 'eng-input',
            placeholder: '按意图/做法/类型搜冷档（回车）…',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submit() },
          }),
          h('select', { className: 'eng-select', style: { width: 130 }, value: year, onChange: (event) => setYear(event.target.value) },
            h('option', { value: '' }, '全部年份'),
            years.map((item) => h('option', { key: item.year, value: String(item.year) }, `${item.year} 年 · ${item.count} 条`))),
          h(Button, { small: true, onClick: submit }, '搜索'),
          h(Button, { small: true, onClick: () => { setDraft(''); setQuery(''); setYear('') } }, '清空'),
          h('span', { className: 'eng-muted' }, `${total} 条`)),
        h('div', { className: 'eng-split', 'data-open': current === null ? 'false' : 'true' },
          h('div', { className: 'eng-card' },
            rows.length === 0
              ? (list.loading ? h(Skeleton, { rows: 5 }) : list.error ? h(ErrorState, { message: list.error, onRetry: list.reload }) : h(Empty, null, '没有冷档记录（安全阀未触发）'))
              : h('div', { className: 'eng-list' }, rows.map((row) => {
              const [label, tone] = outcomeOf(row.outcome)
              return h('button', { key: row.id, type: 'button', className: 'eng-row eng-row-button', 'data-on': selected === row.id ? 'true' : 'false', onClick: () => setSelected(row.id) },
                h(Badge, { tone }, label),
                h('div', { className: 'eng-row-main' }, h('div', { className: 'eng-row-intent' }, row.intent || '（无意图）'), h('div', { className: 'eng-row-sub' }, `${row.typeName || '未分类'} · ${row.action || '—'}`)),
                h('span', { className: 'eng-mono' }, `G ${fmtNumber(row.G)}`),
                h('span', { className: 'eng-muted' }, fmtTime(row.lastSeenAt)))
            })),
            h('div', { className: 'eng-pager' },
              h('span', { className: 'eng-muted' }, `共 ${total} 条 · 第 ${page + 1}/${pages} 页`),
              h(Button, { small: true, disabled: page <= 0, onClick: () => setPage(page - 1) }, '上一页'),
              h(Button, { small: true, disabled: page + 1 >= pages, onClick: () => setPage(page + 1) }, '下一页'))),
          h('div', { className: 'eng-card eng-detail-card' },
            current === null ? h(Empty, null, '选一条冷档看只读详情') : h('div', { className: 'eng-detail' },
              h('div', { className: 'eng-actions', style: { marginBottom: 8 } }, h(Badge, { tone: 'muted' }, '冷档'), h('span', { className: 'eng-mono' }, `G ${fmtNumber(current.G)}`)),
              h('h3', { className: 'eng-detail-title' }, current.intent || '（无意图）'),
              h('dl', { className: 'eng-kv' },
                h('dt', null, '做法'), h('dd', null, current.action || '—'),
                h('dt', null, '类型'), h('dd', null, current.typeName || '—'),
                h('dt', null, '结果'), h('dd', null, outcomeOf(current.outcome)[0]),
                h('dt', null, '最后使用'), h('dd', null, fmtTime(current.lastSeenAt)),
                h('dt', null, 'id'), h('dd', { className: 'eng-mono' }, current.id)),
              h('div', { className: 'eng-muted', style: { marginTop: 12, fontSize: 11 } }, '冷档条目只读：不可反馈、不可编辑、不可删除。')))))
    }

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

    const GRAPH_NODE_CAP = 1200
    const GRAPH_PALETTES = {
      dsh: {},
      codex: { bg: '#050418', bgInner: '#0d0b26', node: CODEX_STAR_STOPS[0].node, node2: CODEX_STAR_STOPS[0].node2, edge: CODEX_STAR_STOPS[0].edge, highlight: CODEX_STAR_STOPS[0].highlight, warn: '#c084fc', ok: '#7aaaff', bad: '#f472b6', glow: CODEX_STAR_STOPS[0].glow, dust: CODEX_STAR_STOPS[0].dust, bloom: 20, dark: true },
      universe: { bg: '#02070d', bgInner: '#061a26', node: '#7df9ff', node2: '#4da3ff', edge: '#2ec5ff', highlight: '#eaffff', warn: '#ffd166', ok: '#7dffd4', bad: '#ff4f9a', glow: '#00e5ff', dust: '#bff8ff', bloom: 22, dark: true },
      cosmos: { bg: '#000714', bgInner: '#07142f', node: '#88def6', node2: '#cc32b2', edge: '#2f2ce0', highlight: '#e9f3ff', warn: '#ffd166', ok: '#7dffd4', bad: '#ff4f9a', glow: '#7a3cff', dust: '#cfe0ff', bloom: 22, dark: true },
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

    /** 恒星芒：8 条长短交替的射线，慢慢转，给中心主星一点“恒星”感。 */
    function drawStarRays(ctx, length, color, alpha, phase) {
      if (!(length > 3)) return
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = withAlpha(color, alpha)
      ctx.lineCap = 'round'
      ctx.lineWidth = Math.max(0.7, Math.min(1.6, length * 0.018))
      for (let index = 0; index < 8; index += 1) {
        const angle = phase + (Math.PI / 4) * index
        const inner = length * 0.16
        const outer = index % 2 === 0 ? length : length * 0.62
        ctx.beginPath()
        ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner)
        ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer)
        ctx.stroke()
      }
      ctx.restore()
    }

    /** 两根屏幕固定（billboard）的光晕条：有自己的慢旋转 + 呼吸式闪烁/伸缩。 */
    function drawCameraSunBars(ctx, radius, color, time = 0) {
      if (!(radius > 3)) return
      const spin = time * 0.06
      const breathe = 0.86 + 0.14 * Math.sin(time * 0.7)
      const bars = [[-0.16, 5.6, 0.5], [0.92, 4.0, 0.34]]
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      for (let index = 0; index < bars.length; index += 1) {
        const [baseAngle, lengthScale, alpha] = bars[index]
        const angle = baseAngle + spin + index * 0.18
        const ux = Math.cos(angle)
        const uy = Math.sin(angle)
        const flicker = 0.82 + 0.18 * Math.sin(time * 0.9 + index * 1.7)
        const half = radius * lengthScale * (0.92 + 0.08 * Math.sin(time * 0.55 + index * 2.1))
        const xA = -ux * half
        const yA = -uy * half
        const xB = ux * half
        const yB = uy * half
        const gradient = ctx.createLinearGradient(xA, yA, xB, yB)
        gradient.addColorStop(0, withAlpha(color, 0))
        gradient.addColorStop(0.5, withAlpha(color, alpha * flicker * breathe))
        gradient.addColorStop(1, withAlpha(color, 0))
        ctx.strokeStyle = gradient
        ctx.globalAlpha = 0.4
        ctx.lineWidth = Math.max(1.6, radius * 0.72 * breathe)
        ctx.beginPath()
        ctx.moveTo(xA, yA)
        ctx.lineTo(xB, yB)
        ctx.stroke()
        ctx.globalAlpha = 0.85
        ctx.lineWidth = Math.max(0.8, radius * 0.22 * breathe)
        ctx.beginPath()
        ctx.moveTo(xA, yA)
        ctx.lineTo(xB, yB)
        ctx.stroke()
      }
      ctx.restore()
    }

    /** 5 种正多面体：线框 + 半透明面；顶点已归一到单位球。 */
    function buildGraphSolids() {
      const norm = (v) => { const len = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / len, v[1] / len, v[2] / len] }
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      const edgesOf = (vertices, faces) => {
        const set = new Set()
        for (const face of faces) {
          for (let i = 0; i < face.length; i += 1) {
            const a = face[i]
            const b = face[(i + 1) % face.length]
            set.add(a < b ? a + ':' + b : b + ':' + a)
          }
        }
        return [...set].map((key) => key.split(':').map(Number))
      }
      const tetra = {
        vertices: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map(norm),
        faces: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
      }
      tetra.edges = edgesOf(tetra.vertices, tetra.faces)
      const cube = {
        vertices: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map(norm),
        faces: [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
      }
      cube.edges = edgesOf(cube.vertices, cube.faces)
      const octa = {
        vertices: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(norm),
        faces: [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]],
      }
      octa.edges = edgesOf(octa.vertices, octa.faces)
      const t = (1 + Math.sqrt(5)) / 2
      const raw = []
      for (const a of [1, -1]) for (const b of [1, -1]) {
        raw.push([0, a, b * t], [a, b * t, 0], [b * t, 0, a])
      }
      const icoVertices = raw.map(norm)
      const icoFaces = []
      const edgeSet = new Set()
      for (let i = 0; i < raw.length; i += 1) for (let j = i + 1; j < raw.length; j += 1) {
        if (Math.abs(Math.hypot(raw[i][0] - raw[j][0], raw[i][1] - raw[j][1], raw[i][2] - raw[j][2]) - 2) < 0.01) edgeSet.add(i + ':' + j)
      }
      for (let i = 0; i < raw.length; i += 1) for (let j = i + 1; j < raw.length; j += 1) for (let k = j + 1; k < raw.length; k += 1) {
        if (edgeSet.has(i + ':' + j) && edgeSet.has(i + ':' + k) && edgeSet.has(j + ':' + k)) icoFaces.push([i, j, k])
      }
      const icosa = { vertices: icoVertices, faces: icoFaces }
      icosa.edges = edgesOf(icoVertices, icoFaces)
      const dual = icoFaces.map((face) => norm(face.reduce((sum, index) => [sum[0] + icoVertices[index][0] / 3, sum[1] + icoVertices[index][1] / 3, sum[2] + icoVertices[index][2] / 3], [0, 0, 0])))
      const around = icoVertices.map((vertex, index) => icoFaces.map((face, fi) => (face.includes(index) ? fi : -1)).filter((fi) => fi >= 0))
      const dodecaFaces = around.map((faceIndexes, vertexIndex) => {
        const n = norm(icoVertices[vertexIndex])
        const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
        const u = norm(cross(n, ref))
        const w = cross(n, u)
        return faceIndexes.slice().sort((a, b) => {
          const pa = dual[a]
          const pb = dual[b]
          return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u))
        })
      })
      const dodeca = { vertices: dual, faces: dodecaFaces }
      dodeca.edges = edgesOf(dual, dodecaFaces)
      return { tetra, cube, octa, dodeca, icosa }
    }
    const GRAPH_SOLIDS = buildGraphSolids()
    const GRAPH_SOLID_FOR_KIND = { root: 'icosa', type: 'dodeca', suite: 'cube', skill: 'tetra' }
    const GRAPH_SUN_DEFAULT = { hot: '#ffffff', glow: '#ffffff', ray: '#ffffff', core: '#ffffff' }
    const GRAPH_SUN_UNIVERSE = { hot: '#dbe7ff', glow: '#7a6bff', ray: '#eaf1ff', core: '#ffffff' }
    const GRAPH_SUN_COSMOS = { hot: '#e6f0ff', glow: '#5d8dff', ray: '#eef6ff', core: '#ffffff' }
    const GRAPH_SUN = GRAPH_SUN_DEFAULT
    const GRAPH_SUN_BAR = '#fff2c6'
    const GRAPH_POLY_BUDGET = 80
    const STAR_CORE_BOOST = 1.5
    /** 主技能=没有父级的顶层技能，用正八面体；子技能仍是正四面体。 */
    const graphSolidForNode = (node) => (node && node.kind === 'skill' && (!node.parent || node.depth === 0) ? GRAPH_SOLIDS.octa : GRAPH_SOLIDS[GRAPH_SOLID_FOR_KIND[node.kind]])

    /** 发光线框正多面体：面半透明、棱线带 shadowBlur，按 spine 自旋。 */
    function drawPolyhedron(ctx, radius, color, solid, spin, options = {}) {
      if (!solid || radius <= 0.4) return
      const cosY = Math.cos(spin)
      const sinY = Math.sin(spin)
      const cosX = Math.cos(spin * 0.63)
      const sinX = Math.sin(spin * 0.63)
      const points = solid.vertices.map((vertex) => {
        const x = vertex[0] * cosY + vertex[2] * sinY
        const z = -vertex[0] * sinY + vertex[2] * cosY
        const y = vertex[1]
        return { x: x * radius, y: (y * cosX - z * sinX) * radius, z: y * sinX + z * cosX }
      })
      const edgeInfo = solid.edges.map(([a, b]) => ({ a, b, depth: (points[a].z + points[b].z) / 2 }))
      const faceDepth = solid.faces.map((face) => ({ face, z: face.reduce((sum, index) => sum + points[index].z, 0) / face.length }))
      const frontFaces = faceDepth.filter((face) => face.z >= 0)
      const baseWidth = Math.max(0.65, Math.min(2.2, radius * 0.075))
      ctx.save()
      // 正面片合并成一次 fill。
      if (frontFaces.length > 0) {
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = withAlpha(color, options.faceAlpha === undefined ? 0.36 : options.faceAlpha)
        ctx.beginPath()
        for (const { face } of frontFaces) {
          face.forEach((index, order) => {
            const point = points[index]
            if (order === 0) ctx.moveTo(point.x, point.y)
            else ctx.lineTo(point.x, point.y)
          })
          ctx.closePath()
        }
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'lighter'
      // 棱按深度分 6 档：从背后 0.22 渐亮到正面 0.96，不再“转到一半突然变暗”。
      const bands = 6
      const buckets = Array.from({ length: bands }, () => [])
      for (const edge of edgeInfo) {
        const t = Math.max(0, Math.min(1, (edge.depth + 1) / 2))
        buckets[Math.min(bands - 1, Math.floor(t * bands))].push(edge)
      }
      if (options.glow) {
        ctx.strokeStyle = withAlpha(color, 0.10)
        ctx.lineWidth = baseWidth * 3.4
        ctx.beginPath()
        for (const { a, b } of edgeInfo) {
          ctx.moveTo(points[a].x, points[a].y)
          ctx.lineTo(points[b].x, points[b].y)
        }
        ctx.stroke()
      }
      for (let band = 0; band < bands; band += 1) {
        const list = buckets[band]
        if (list.length === 0) continue
        const depth = (band + 0.5) / bands
        const alpha = Math.min(1, (0.22 + 0.74 * Math.pow(depth, 1.15)) * (options.edgeAlpha === undefined ? 0.95 : options.edgeAlpha))
        ctx.strokeStyle = withAlpha(lightenColor(color, 0.55), alpha)
        ctx.lineWidth = baseWidth * (0.9 + depth * 0.18)
        ctx.beginPath()
        for (const { a, b } of list) {
          ctx.moveTo(points[a].x, points[a].y)
          ctx.lineTo(points[b].x, points[b].y)
        }
        ctx.stroke()
      }
      ctx.restore()
    }

    function drawGraphShape(ctx, radius, kind = 'experience') {
      if (radius <= 0.2) return
      ctx.beginPath()
      if (kind === 'type') {
        // 类型是“主星”：六边形，和经验的圆点一眼分得开。
        for (let index = 0; index < 6; index += 1) {
          const angle = (Math.PI / 3) * index - Math.PI / 6
          const x = Math.cos(angle) * radius * 1.04
          const y = Math.sin(angle) * radius * 1.04
          if (index === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
      } else if (kind === 'skill') {
        // 技能是菱形，套件仍用圆 + 外虚线环，经验是圆点。
        ctx.moveTo(0, -radius * 1.18)
        ctx.lineTo(radius * 0.82, 0)
        ctx.lineTo(0, radius * 1.18)
        ctx.lineTo(-radius * 0.82, 0)
        ctx.closePath()
      } else {
        ctx.arc(0, 0, radius, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.stroke()
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

    /** 主题强调色采样：品牌色/链接色/状态色 + 背景渐变里所有鲜艳停靠点。 */
    function readThemeAccentColors(themeStops, fallback) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return [fallback]
      const root = getComputedStyle(document.documentElement)
      const read = (name) => (root.getPropertyValue(name) || '').trim()
      const names = [
        '--dsw-alias-brand-primary',
        '--dsw-alias-brand-primary-new-colorprimary-new-color',
        '--dsw-alias-link',
        '--dsw-alias-state-warn-primary',
        '--dsw-alias-state-success-primary',
        '--dsw-alias-state-error-primary',
      ]
      const raw = []
      for (const name of names) {
        const value = read(name)
        if (value) raw.push(value)
      }
      for (const color of themeStops) raw.push(color)
      if (raw.length === 0) raw.push(fallback)
      const seen = new Set()
      const colors = []
      for (const color of raw) {
        const rgb = parseRgbColor(color)
        if (rgb === null) continue
        const hsl = rgbToHsl(rgb)
        if (hsl.s < 0.16 || hsl.l < 0.12 || hsl.l > 0.94) continue
        const hex = hslToHex(hsl.h, hsl.s, hsl.l)
        if (seen.has(hex)) continue
        seen.add(hex)
        colors.push(hex)
      }
      return colors.length > 0 ? colors : [fallback]
    }

    function hueOf(color) {
      const rgb = parseRgbColor(color)
      return rgb === null ? 0 : rgbToHsl(rgb).h
    }

    function hueDistance(left, right) {
      const delta = Math.abs(hueOf(left) - hueOf(right))
      return Math.min(delta, 1 - delta)
    }

    function readResolvedToken(name) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return ''
      try {
        const root = getComputedStyle(document.documentElement)
        return (root.getPropertyValue(name) || '').trim()
      } catch {
        return ''
      }
    }

    function buildThemeAccentPalette(themeStops, dark, fallback) {
      const colors = readThemeAccentColors(themeStops, fallback)
      const brand = readResolvedToken('--dsw-alias-brand-primary')
      const link = readResolvedToken('--dsw-alias-link')
      const primaryRaw = brand || link || colors[0] || fallback
      const accent = vividColor(primaryRaw, dark)
      const candidates = themeStops
        .filter((color) => hueDistance(color, accent) >= 0.08)
        .map((color) => vividColor(color, dark))
      let secondary = candidates[0]
      if (!secondary) {
        const hsl = rgbToHsl(parseRgbColor(accent) || { r: 65, g: 118, b: 230 })
        secondary = hslToHex(hsl.h + 0.12, Math.max(0.55, hsl.s), dark ? 0.68 : 0.56)
      } else {
        secondary = vividColor(secondary, dark)
      }
      return {
        node: accent,
        nodeLight: lightenColor(accent, 0.4),
        node2: secondary,
        edge: accent,
        highlight: lightenColor(secondary, 0.35),
        glow: accent,
        dust: lightenColor(secondary, 0.55),
      }
    }

    function readDshGraphPalette(canvas) {
      const local = getComputedStyle(canvas)
      const root = getComputedStyle(document.documentElement)
      const read = (name, fallback) => (local.getPropertyValue(name) || root.getPropertyValue(name) || '').trim() || fallback
      const bg = read('--dsw-alias-bg-layer-1', '#ffffff')
      const bgInner = read('--dsw-alias-bg-layer-2', bg)
      const rgb = bg.match(/d+(.d+)?/g) || ['255', '255', '255']
      const luminance = (Number(rgb[0]) * 0.299 + Number(rgb[1]) * 0.587 + Number(rgb[2]) * 0.114) / 255
      const dark = luminance < 0.45
      const themeStops = graphStops(readThemeGradientStops(), dark)
      const star = CODEX_STAR_STOPS[dark ? 1 : 0]
      const accent = buildThemeAccentPalette(themeStops, dark, star.node)
      return {
        bg: bgInner,
        bgInner: bg,
        ...accent,
        warn: vividColor(read('--dsw-alias-state-warn-primary', '#d69e2e'), dark),
        ok: vividColor(read('--dsw-alias-state-success-primary', '#38a169'), dark),
        bad: vividColor(read('--dsw-alias-state-error-primary', '#e53e3e'), dark),
        ringFill: dark ? 'rgba(8, 12, 20, .55)' : 'rgba(255, 255, 255, .62)',
        dark,
        bloom: dark ? 12 : 7,
      }
    }

    /**
     * 关系图布局（纯函数，O(N+E)）：类型球面锚点、经验按类型分层、技能/套件按父子环摆放。
     * 抽出来是为了能单测 1k/3k 夹具；不依赖 React / DOM。
     */
    function layoutGraph(data) {
      const nodes = Array.isArray(data && data.nodes) ? data.nodes : []
      const edges = Array.isArray(data && data.edges) ? data.edges : []
      const hash = (text) => {
        let value = 2166136261
        const raw = String(text)
        for (let index = 0; index < raw.length; index += 1) {
          value ^= raw.charCodeAt(index)
          value = Math.imul(value, 16777619)
        }
        return value >>> 0
      }
      const rand = (text) => (hash(text) % 100000) / 100000
      const nodeById = new Map(nodes.map((node) => [node.id, node]))
      const types = nodes.filter((node) => node.kind === 'type')
      const experiences = nodes.filter((node) => node.kind === 'experience')
      const hierarchy = nodes.filter((node) => node.kind === 'skill' || node.kind === 'suite')
      const parentOf = new Map()
      const childrenByParent = new Map()
      const derivedByTarget = new Map()
      for (const edge of edges) {
        if (edge.kind === 'suite') {
          parentOf.set(edge.target, edge.source)
          const list = childrenByParent.get(edge.source) || []
          list.push(edge.target)
          childrenByParent.set(edge.source, list)
        } else if (edge.kind === 'derived') {
          const list = derivedByTarget.get(edge.target) || []
          list.push(edge.source)
          derivedByTarget.set(edge.target, list)
        }
      }
      const centers = new Map()
      const total = Math.max(1, types.length)
      types.forEach((node, index) => {
        const y = total === 1 ? 0 : 0.88 - (index / (total - 1)) * 1.76
        const ring = Math.sqrt(Math.max(0, 1 - y * y))
        const phi = index * Math.PI * (3 - Math.sqrt(5)) + rand(node.id) * 0.5
        const radius = 360 + rand(`${node.id}r`) * 40
        centers.set(node.id, { x: Math.cos(phi) * ring * radius, y: y * radius * 0.78, z: Math.sin(phi) * ring * radius })
      })
      const positions = new Map()
      for (const node of types) positions.set(node.id, centers.get(node.id))
      const expByType = new Map()
      for (const node of experiences) {
        const key = `type:${node.typeId}`
        const list = expByType.get(key) || []
        list.push(node)
        expByType.set(key, list)
      }
      for (const [key, list] of expByType) {
        const center = centers.get(key) || { x: 0, y: 0, z: 0 }
        // 同类型经验用黄金角均匀铺在球壳上，只按权重调半径，不再随机堆成团。
        list.sort((left, right) => (Number(right.weight) || 0) - (Number(left.weight) || 0))
        for (let index = 0; index < list.length; index += 1) {
          const node = list[index]
          const weight = Math.max(0.06, Math.min(1, Number(node.weight) || 0.3))
          const y = list.length === 1 ? 0.18 : 0.55 - (index / (list.length - 1)) * 1.1
          const ring = Math.sqrt(Math.max(0, 1 - y * y))
          const phi = index * 2.399963 + rand(`${node.id}a`) * 0.3
          const rr = 22 + (1 - Math.pow(weight, 0.65)) * 34 + rand(`${node.id}r`) * 2
          positions.set(node.id, {
            x: center.x + Math.cos(phi) * ring * rr,
            y: center.y + y * rr * 0.72,
            z: center.z + Math.sin(phi) * ring * rr,
          })
        }
      }
      const queue = []
      let skillIndex = 0
      for (const node of hierarchy) {
        if (parentOf.has(node.id)) continue
        let base
        if (node.kind === 'suite') {
          const a = rand(`${node.id}a`) * Math.PI * 2
          const b = Math.acos(2 * rand(`${node.id}b`) - 1)
          const rr = 500 + rand(`${node.id}r`) * 60
          base = { x: Math.sin(b) * Math.cos(a) * rr, y: Math.cos(b) * rr * 0.8, z: Math.sin(b) * Math.sin(a) * rr }
        } else {
          const derived = (derivedByTarget.get(node.id) || []).map((id) => positions.get(id)).filter(Boolean)
          if (derived.length > 0) {
            base = derived.reduce((sum, item) => ({ x: sum.x + item.x / derived.length, y: sum.y + item.y / derived.length, z: sum.z + item.z / derived.length }), { x: 0, y: 0, z: 0 })
          } else {
            // 顶层技能沿黄金角排成外环，y 只做小幅散开，整体更均匀。
            const phi = skillIndex * 2.399963 + rand(`${node.id}a`) * 0.2
            const rr = 560 + rand(`${node.id}r`) * 70
            base = { x: Math.cos(phi) * rr, y: (rand(`${node.id}y`) - 0.5) * 180, z: Math.sin(phi) * rr }
            skillIndex += 1
          }
          const a = rand(`${node.id}a`) * Math.PI * 2
          base = { x: base.x + Math.cos(a) * 46, y: base.y + (rand(`${node.id}y`) - 0.5) * 60, z: base.z + Math.sin(a) * 46 }
        }
        positions.set(node.id, base)
        queue.push(node)
      }
      while (queue.length > 0) {
        const parent = queue.shift()
        const base = positions.get(parent.id) || { x: 0, y: 0, z: 0 }
        const children = (childrenByParent.get(parent.id) || []).map((id) => nodeById.get(id)).filter(Boolean)
        if (children.length === 0) continue
        const rr = 42 + Math.sqrt(children.length) * 13
        children.forEach((child, index) => {
          const y = children.length === 1 ? 0 : 1 - (index / (children.length - 1)) * 2
          const ring = Math.sqrt(Math.max(0, 1 - y * y))
          const phi = index * Math.PI * (3 - Math.sqrt(5)) + rand(child.id) * 0.4
          positions.set(child.id, {
            x: base.x + Math.cos(phi) * ring * rr,
            y: base.y + y * rr * 0.72,
            z: base.z + Math.sin(phi) * ring * rr,
          })
          queue.push(child)
        })
      }
      for (const node of hierarchy) {
        if (positions.has(node.id)) continue
        const a = rand(`${node.id}a`) * Math.PI * 2
        const b = Math.acos(2 * rand(`${node.id}b`) - 1)
        const rr = 450 + rand(`${node.id}r`) * 90
        positions.set(node.id, { x: Math.sin(b) * Math.cos(a) * rr, y: Math.cos(b) * rr * 0.8, z: Math.sin(b) * Math.sin(a) * rr })
      }
      // 所有星球都略微离开太阳两极：纬度限制 0.9；正好落在轴上的给一点横向偏移。
      const LAT_LIMIT = 0.9
      for (const [id, point] of positions) {
        const radius = Math.hypot(point.x, point.y, point.z)
        if (!(radius > 0.01)) continue
        const maxY = radius * LAT_LIMIT
        if (Math.abs(point.y) > maxY) {
          point.y = Math.sign(point.y) * maxY
          const horizontal = Math.hypot(point.x, point.z)
          if (horizontal < radius * 0.15) {
            const angle = rand(`${id}lat`) * Math.PI * 2
            const next = Math.sqrt(Math.max(0, Math.pow(radius * 0.96, 2) - point.y * point.y))
            point.x = Math.cos(angle) * next
            point.z = Math.sin(angle) * next
          }
        }
      }
      return positions
    }
    function Graph() {
      const graph = useLoad(useCallback(() => request('/graph'), []))
      const settings = useLoad(useCallback(() => request('/settings'), []))
      const canvasRef = useRef(null)
      const wrapRef = useRef(null)
      const fitRef = useRef(null)
      const zoomRef = useRef(null)
      const [fullscreen, setFullscreen] = useState(false)
      const [selection, setSelection] = useState(null)
      const [paused, setPaused] = useState(false)
      const [simple, setSimple] = useState(false)
      const [query, setQuery] = useState('')
      const [kindFilter, setKindFilter] = useState('all')
      const [resultFilter, setResultFilter] = useState('all')
      const [recentOnly, setRecentOnly] = useState(false)
      // 「加载全部」：临时跳过 1,200 上限；「图例点击」：只看某一类（不覆盖 kindFilter）。
      const [allowAll, setAllowAll] = useState(false)
      const [focusedType, setFocusedType] = useState(null)
      const [isolate, setIsolate] = useState(false)
      const [panelOpen, setPanelOpen] = useState(false)
      const searchRef = useRef(null)
      useEffect(() => {
        const onChange = () => setFullscreen(Boolean(document.fullscreenElement && wrapRef.current && document.fullscreenElement === wrapRef.current))
        document.addEventListener('fullscreenchange', onChange)
        return () => document.removeEventListener('fullscreenchange', onChange)
      }, [])
      const toggleFullscreen = async () => {
        const element = wrapRef.current
        if (!element) return
        try {
          if (document.fullscreenElement) await document.exitFullscreen()
          else if (typeof element.requestFullscreen === 'function') await element.requestFullscreen()
        } catch {
          // 浏览器拒绝全屏（权限/手势）时保持原样，不弹窗。
        }
      }
      useEffect(() => {
        if (panelOpen && searchRef.current) searchRef.current.focus()
      }, [panelOpen])
      const viewData = useMemo(() => {
        if (!graph.data) return graph.data
        let data = graph.data
        const allNodes = Array.isArray(data.nodes) ? data.nodes : []
        if (!allowAll && allNodes.length > GRAPH_NODE_CAP) {
          const structural = allNodes.filter((node) => node.kind !== 'experience')
          const experiences = allNodes.filter((node) => node.kind === 'experience')
            .sort((left, right) => (Number(right.weight) || 0) - (Number(left.weight) || 0))
          const nodes = [...structural, ...experiences].slice(0, GRAPH_NODE_CAP)
          const ids = new Set(nodes.map((node) => node.id))
          data = {
            ...data,
            nodes,
            edges: (data.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
            truncated: true,
            total: allNodes.length,
          }
        }
        if (focusedType !== null) {
          const nodes = (data.nodes || []).filter((node) => node.id === focusedType
            || (node.kind === 'experience' && `type:${node.typeId}` === focusedType))
          const ids = new Set(nodes.map((node) => node.id))
          data = { ...data, nodes, edges: (data.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target)) }
        }
        if (resultFilter !== 'all' || recentOnly) {
          const cutoff = recentOnly ? Date.now() - 30 * 86400000 : null
          const nodes = (data.nodes || []).filter((node) => {
            if (node.kind !== 'experience') return true
            if (resultFilter !== 'all' && node.outcome !== resultFilter) return false
            if (cutoff !== null) {
              const stamp = Date.parse(String(node.lastSeenAt || ''))
              if (!Number.isFinite(stamp) || stamp < cutoff) return false
            }
            return true
          })
          const ids = new Set(nodes.map((node) => node.id))
          data = { ...data, nodes, edges: (data.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target)) }
        }
        if (!simple) {
          if (kindFilter === 'all') return data
          const nodes = (data.nodes || []).filter((node) => node.kind === kindFilter)
          const ids = new Set(nodes.map((node) => node.id))
          return { ...data, nodes, edges: (data.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target)) }
        }
        const nodes = (data.nodes || []).filter((node) => node.kind !== 'experience')
        const ids = new Set(nodes.map((node) => node.id))
        const edges = (data.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        return { ...data, nodes, edges }
      }, [graph.data, allowAll, focusedType, simple, kindFilter, resultFilter, recentOnly])
      const searchHits = useMemo(() => {
        const term = query.trim().toLowerCase()
        if (term === '') return []
        const nodes = viewData && Array.isArray(viewData.nodes) ? viewData.nodes : []
        return nodes.filter((node) => `${node.label || ''} ${node.id || ''}`.toLowerCase().includes(term)).slice(0, 6)
      }, [query, viewData])
      const stateRef = useRef({
        nodes: new Map(), edges: new Map(), dust: [],
        cam: { yaw: -0.42, pitch: 0.26, dist: 1420 },
        selected: null, hovered: null, pulse: 0, t: 0, dragging: null, dragMoved: false, userZoom: false, fit: null,
      })
      const selectNode = (node) => {
        if (!node) return
        stateRef.current.selected = node.id
        stateRef.current.pulse = 0
        setSelection(node)
      }
      // 图上那个胶囊：手动切「跟随主题 / 蓝紫星辰」，写进 ui.graphPalette。
      const graphUi = (settings.data && settings.data.ui) || {}
      const [paletteOverride, setPaletteOverride] = useState(() => {
        try { return localStorage.getItem('eng:graphPalette') || '' } catch { return '' }
      })
      const paletteNow = GRAPH_PALETTES[paletteOverride] ? paletteOverride : (GRAPH_PALETTES[graphUi.graphPalette] ? graphUi.graphPalette : 'codex')
      const surfaceNow = ['theme', 'light', 'dark'].includes(graphUi.graphSurface) ? graphUi.graphSurface : 'theme'
      const pickPalette = async (key) => {
        if (key === paletteNow) return
        setPaletteOverride(key)
        try { localStorage.setItem('eng:graphPalette', key) } catch {}
        try {
          await request('/settings', { method: 'POST', body: { ui: { graphPalette: key } } })
          await settings.reload()
        } catch (caught) {
          console.error('[engram] graph palette save failed', caught)
        }
      }
      const pickSurface = async (key) => {
        if (key === surfaceNow) return
        try {
          await request('/settings', { method: 'POST', body: { ui: { graphSurface: key } } })
          await settings.reload()
        } catch (caught) {
          console.error('[engram] graph surface save failed', caught)
        }
      }
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !viewData) return undefined
        const ui = (settings.data && settings.data.ui) || {}
        const paletteKey = GRAPH_PALETTES[ui.graphPalette] ? ui.graphPalette : 'codex'
        let palette = paletteKey === 'dsh'
          ? readDshGraphPalette(canvas)
          : (() => {
              const base = GRAPH_PALETTES[paletteKey]
              // 保留调色板自己的第二色/高亮色，别再压成单色（否则自选配色也没有渐变层次）
              return { ...base, nodeLight: lightenColor(base.node, 0.5) }
            })()
        // 左下角胶囊强制深/浅背景时，画布底色和「暗色主题」判定一起跟着切。
        if (paletteKey !== 'universe' && (ui.graphSurface === 'dark' || ui.graphSurface === 'light')) {
          const forcedDark = ui.graphSurface === 'dark'
          palette = {
            ...palette,
            dark: forcedDark,
            ringFill: forcedDark ? 'rgba(8, 12, 20, .55)' : 'rgba(255, 255, 255, .62)',
          }
        }
        const rotation = paused ? 0 : (Number.isFinite(Number(ui.graphRotation)) ? Number(ui.graphRotation) : 0.025)
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
        let lastInteraction = performance.now()
        let lastDrawAt = 0
        let onScreen = true
        const visibilityObserver = typeof IntersectionObserver === 'function'
          ? new IntersectionObserver((entries) => { onScreen = entries.some((entry) => entry.isIntersecting) })
          : null
        if (visibilityObserver !== null) visibilityObserver.observe(canvas)
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
          dpr = Math.min(1.5, window.devicePixelRatio || 1)
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        }
        const radiusOf = (node, weight) => {
          const w = Math.max(0.06, Math.min(1, Number(weight) || 0.3))
          if (node.kind === 'root') return 9 + Math.pow(w, 0.85) * 3
          if (node.kind === 'type') return 4 + Math.pow(w, 0.85) * 7
          if (node.kind === 'suite') return 6 + Math.pow(w, 0.85) * 6
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
        const sync = (data) => {
          const positions = layoutGraph(data)
          const parentMap = new Map()
          for (const edge of data.edges || []) {
            if (edge.kind === 'type') parentMap.set(edge.target, edge.source)
            else if (edge.kind === 'suite') parentMap.set(edge.target, edge.source)
          }
          const seen = new Set()
          for (const node of data.nodes) {
            seen.add(node.id)
            const shape = node.kind === 'root' ? { x: 0, y: 0, z: 0 } : (positions.get(node.id) || { x: 0, y: 0, z: 0 })
            const existing = store.nodes.get(node.id)
            if (existing) {
              existing.node = node
              if (!Number.isFinite(existing.baseX)) {
                existing.baseX = existing.x
                existing.baseY = existing.y
                existing.baseZ = existing.z
              }
              existing.targetX = shape.x
              existing.targetY = shape.y
              existing.targetZ = shape.z
              existing.targetWeight = Number(node.weight) || 0.3
              existing.targetAlpha = 1
              existing.parentId = parentMap.get(node.id) || null
              existing.orbitSpeed = node.kind === 'experience' ? 0.16 + 0.30 * Math.pow(Math.max(0.06, Math.min(1, Number(node.weight) || 0.3)), 1.8) : 0
              existing.spinSpeed = node.kind === 'type' ? 0.10 : node.kind === 'suite' ? 0.12 : node.kind === 'skill' ? 0.14 : node.kind === 'root' ? 0.06 : 0.08
            } else {
              store.nodes.set(node.id, {
                node, x: shape.x, y: shape.y, z: shape.z,
                baseX: shape.x, baseY: shape.y, baseZ: shape.z,
                targetX: shape.x, targetY: shape.y, targetZ: shape.z,
                parentId: parentMap.get(node.id) || null,
                orbitSpeed: node.kind === 'experience' ? 0.16 + 0.30 * Math.pow(Math.max(0.06, Math.min(1, Number(node.weight) || 0.3)), 1.8) : 0,
                spinSpeed: node.kind === 'type' ? 0.10 : node.kind === 'suite' ? 0.12 : node.kind === 'skill' ? 0.14 : node.kind === 'root' ? 0.06 : 0.08,
                spinAngle: 0,
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
          const cell = 32
          const grid = new Map()
          for (const [, entry] of store.nodes) {
            if (entry.alpha < 0.15) continue
            const key = `${Math.floor(entry.screenX / cell)},${Math.floor(entry.screenY / cell)}`
            const list = grid.get(key) || []
            list.push(entry)
            grid.set(key, list)
          }
          let best = null
          let bestDistance = 26
          const cx = Math.floor(x / cell)
          const cy = Math.floor(y / cell)
          for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
            for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
              for (const entry of (grid.get(`${gx},${gy}`) || [])) {
                const distance = Math.hypot(entry.screenX - x, entry.screenY - y)
                if (distance < Math.max(bestDistance, entry.r + 6) && distance < bestDistance + entry.r) {
                  best = entry
                  bestDistance = distance
                }
              }
            }
          }
          return best
        }
        const onPointerDown = (event) => {
          if (event.button !== 0) return
          lastInteraction = performance.now()
          store.autoPauseUntil = 0
          store.dragging = { x: event.clientX, y: event.clientY, yaw: cam.yaw, pitch: cam.pitch, pointerId: event.pointerId }
          store.dragMoved = false
          canvas.style.cursor = 'grabbing'
          try { if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId) } catch {}
        }
        const onPointerMove = (event) => {
          lastInteraction = performance.now()
          if (store.dragging) {
            const dx = event.clientX - store.dragging.x
            const dy = event.clientY - store.dragging.y
            if (Math.hypot(dx, dy) > 4) store.dragMoved = true
            cam.yaw = store.dragging.yaw + dx * 0.006
            // 拖拽方向贴手：往下拖，画面跟着往下走。
            cam.pitch = Math.max(-1.35, Math.min(1.35, store.dragging.pitch + dy * 0.006))
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
          // 松手后先停自转 1.2s，给用户看一眼刚拖到的角度；再恢复。
          store.autoPauseUntil = performance.now() + 1200
          canvas.style.cursor = 'grab'
          try { if (canvas.releasePointerCapture && event.pointerId !== undefined) canvas.releasePointerCapture(event.pointerId) } catch {}
        }
        const onWheel = (event) => {
          lastInteraction = performance.now()
          event.preventDefault()
          store.userZoom = true
          cam.dist = Math.min(3200, Math.max(520, cam.dist * (event.deltaY > 0 ? 1.08 : 0.92)))
        }
        resize()
        sync(viewData)
        const fitCamera = (immediate = false, scale = 1) => {
          if (store.userZoom && !immediate) return
          let bound = 1
          for (const entry of store.nodes.values()) bound = Math.max(bound, Math.hypot(entry.x, entry.y, entry.z))
          const target = Math.max(900, Math.min(2800, bound * 2.9 * scale))
          if (immediate) {
            cam.dist = target
            store.fit = null
          } else {
            store.fit = { from: cam.dist, to: target, at: performance.now() }
          }
        }
        // 进入关系图时按“滚轮再放大两档”的默认大小（0.81 = 两次滚轮缩放）。
        fitCamera(true, 0.81)
        fitRef.current = () => { store.userZoom = false; fitCamera(false) }
        zoomRef.current = (factor) => { store.userZoom = true; cam.dist = Math.min(3200, Math.max(520, cam.dist * factor)) }
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
        const onFullscreen = () => requestAnimationFrame(() => { resize(); fitCamera(true) })
        window.addEventListener('resize', onResize)
        document.addEventListener('fullscreenchange', onFullscreen)
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        canvas.addEventListener('pointerdown', onPointerDown)
        canvas.addEventListener('pointerleave', onPointerLeave)
        canvas.addEventListener('wheel', onWheel, { passive: false })
        canvas.style.cursor = 'grab'
        let pinchDistance = 0
        const touchSpan = (event) => Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY)
        const onTouchStart = (event) => {
          if (event.touches.length !== 2) return
          pinchDistance = touchSpan(event)
          store.dragging = null
          event.preventDefault()
        }
        const onTouchMove = (event) => {
          if (event.touches.length !== 2 || pinchDistance <= 0) return
          lastInteraction = performance.now()
          const next = touchSpan(event)
          if (next > 0 && zoomRef.current) zoomRef.current(pinchDistance / next)
          pinchDistance = next
          event.preventDefault()
        }
        const onTouchEnd = () => { pinchDistance = 0 }
        canvas.addEventListener('touchstart', onTouchStart, { passive: false })
        canvas.addEventListener('touchmove', onTouchMove, { passive: false })
        canvas.addEventListener('touchend', onTouchEnd)
        canvas.addEventListener('touchcancel', onTouchEnd)
        let frameCount = 0
        const draw = (now) => {
          if ((typeof document !== 'undefined' && document.hidden) || !onScreen) {
            last = now
            raf = requestAnimationFrame(draw)
            return
          }
          const idle = now - lastInteraction > 2000
          if (idle && now - lastDrawAt < 32) {
            last = now
            raf = requestAnimationFrame(draw)
            return
          }
          lastDrawAt = now
          frameCount += 1
          if (frameCount % 30 === 0 && typeof window !== 'undefined') {
            const elapsed = Math.max(1, now - (store.perfAt || now - 500))
            store.perfAt = now
            window.__engGraph = { nodes: store.nodes.size, edges: store.edges.size, fps: Math.round(30000 / elapsed), at: Date.now() }
          }
          if (frameCount % 30 === 0 && paletteKey === 'dsh') palette = readDshGraphPalette(canvas)
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          store.t += dt
          store.pulse += dt * 1.4
          if (store.fit !== null) {
            const progress = Math.min(1, (now - store.fit.at) / 420)
            const eased = 1 - Math.pow(1 - progress, 3)
            cam.dist = store.fit.from + (store.fit.to - store.fit.from) * eased
            if (progress >= 1) store.fit = null
          }
          if (rotation !== 0 && store.dragging === null && now > (store.autoPauseUntil || 0)) cam.yaw += rotation * dt
          const cx = width / 2
          const cy = height / 2
          ctx.clearRect(0, 0, width, height)
          // 很轻的暗角：让视线落在中间的主星上，浅色主题只加一点墨感。
          const vignette = ctx.createRadialGradient(cx, cy, Math.min(width, height) * 0.18, cx, cy, Math.max(width, height) * 0.72)
          vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
          vignette.addColorStop(1, palette.dark ? 'rgba(0, 0, 0, .30)' : 'rgba(15, 23, 42, .045)')
          ctx.fillStyle = vignette
          ctx.fillRect(0, 0, width, height)
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
            const move = Math.min(1, dt * 3)
            if (!Number.isFinite(entry.baseX)) {
              entry.baseX = entry.x
              entry.baseY = entry.y
              entry.baseZ = entry.z
            }
            if (Number.isFinite(entry.targetX)) entry.baseX += (entry.targetX - entry.baseX) * move
            if (Number.isFinite(entry.targetY)) entry.baseY += (entry.targetY - entry.baseY) * move
            if (Number.isFinite(entry.targetZ)) entry.baseZ += (entry.targetZ - entry.baseZ) * move
            entry.spinAngle = store.t * (entry.spinSpeed || 0) + entry.phase
            entry.currentWeight += (entry.targetWeight - entry.currentWeight) * Math.min(1, dt * 4)
            entry.alpha += (entry.targetAlpha - entry.alpha) * Math.min(1, dt * 4)
            entry.r += (radiusOf(entry.node, entry.currentWeight) - entry.r) * Math.min(1, dt * 6)
          }
          for (const entry of store.nodes.values()) {
            const parent = entry.parentId ? store.nodes.get(entry.parentId) : null
            if (parent && parent !== entry) {
              // 小经验像小星星一样绕分类节点公转；技能仍随套件的自旋走。
              const angle = entry.node.kind === 'experience'
                ? store.t * (entry.orbitSpeed || 0.24)
                : (parent.spinAngle || 0)
              const dx = entry.baseX - parent.baseX
              const dz = entry.baseZ - parent.baseZ
              entry.x = parent.baseX + dx * Math.cos(angle) - dz * Math.sin(angle)
              entry.z = parent.baseZ + dx * Math.sin(angle) + dz * Math.cos(angle)
              entry.y = entry.baseY
            } else {
              entry.x = entry.baseX
              entry.y = entry.baseY
              entry.z = entry.baseZ
            }
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
          const edgeList = store.edges
          const pulses = []
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
            ctx.globalAlpha = Math.min(1, (0.025 + strength * 0.32) * near * (bright ? 1.9 : 1)) * (relatedEdge ? 1 : (isolate ? 0.02 : 0.1))
            const isSuiteEdge = edgeState.edge.kind === 'suite'
            const isLabelEdge = edgeState.edge.kind === 'label'
            ctx.strokeStyle = isLabelEdge ? (palette.node2 || palette.edge) : (isSuiteEdge ? (palette.glow || palette.node) : (palette.edge || palette.node))
            ctx.lineWidth = (0.2 + strength * (bright ? 2.4 : (isSuiteEdge ? 2.1 : (isLabelEdge ? 1.0 : 1.7)))) * near
            ctx.setLineDash(isLabelEdge ? [1, 4] : (edgeState.edge.kind === 'suite' ? [5, 3] : (edgeState.edge.kind === 'derived' ? [2, 3] : [])))
            ctx.shadowBlur = !isLabelEdge && bloom && bright ? (4 + strength * 10) * near : 0
            ctx.shadowColor = edgeState.edge.kind === 'derived' ? palette.node2 : palette.glow
            ctx.beginPath()
            ctx.moveTo(from.screenX, from.screenY)
            ctx.lineTo(to.screenX, to.screenY)
            ctx.stroke()
            if (strength > 0.1) {
              const particles = edgeState.particles
              particles[0] = (particles[0] + dt * (0.05 + strength * 0.45) * (bright ? 1.7 : 1)) % 1
              if (pulses.length < 180 || bright) {
                const progress = particles[0]
                const dx = to.screenX - from.screenX
                const dy = to.screenY - from.screenY
                if (Math.hypot(dx, dy) > 1) {
                  const px = from.screenX + dx * progress
                  const py = from.screenY + dy * progress
                  pulses.push({
                    x: px,
                    y: py,
                    r: Math.max(0.7, (0.6 + strength * 1.3) * near),
                    alpha: Math.min(0.95, (0.22 + strength * 0.5) * near * (bright ? 1.35 : 1)),
                    color: bright ? palette.highlight : (palette.glow || palette.highlight),
                  })
                }
              }
            }
          }
          ctx.setLineDash([])
          ctx.shadowBlur = 0
          if (pulses.length > 0) {
            ctx.save()
            ctx.globalCompositeOperation = 'lighter'
            // 能量包：外层柔光 + 中层色晕 + 白热核心，整体只有“点”那么大。
            for (const pulse of pulses) {
              ctx.fillStyle = pulse.color
              ctx.globalAlpha = Math.min(0.42, pulse.alpha * 0.16)
              ctx.beginPath()
              ctx.arc(pulse.x, pulse.y, pulse.r * 3.2, 0, Math.PI * 2)
              ctx.fill()
            }
            for (const pulse of pulses) {
              ctx.fillStyle = pulse.color
              ctx.globalAlpha = Math.min(0.62, pulse.alpha * 0.34)
              ctx.beginPath()
              ctx.arc(pulse.x, pulse.y, pulse.r * 1.85, 0, Math.PI * 2)
              ctx.fill()
            }
            for (const pulse of pulses) {
              ctx.fillStyle = pulse.color
              ctx.globalAlpha = pulse.alpha
              ctx.beginPath()
              ctx.arc(pulse.x, pulse.y, Math.max(0.6, pulse.r), 0, Math.PI * 2)
              ctx.fill()
              ctx.globalAlpha = Math.min(1, pulse.alpha * 0.9)
              ctx.fillStyle = '#ffffff'
              ctx.beginPath()
              ctx.arc(pulse.x, pulse.y, Math.max(0.45, pulse.r * 0.42), 0, Math.PI * 2)
              ctx.fill()
            }
            ctx.restore()
          }
          const ordered = [...store.nodes.values()].sort((left, right) => right.depth - left.depth)
          let polyBudget = GRAPH_POLY_BUDGET
          for (const entry of ordered) {
            if (entry.alpha <= 0.01) { if (entry.targetAlpha === 0) store.nodes.delete(entry.node.id); continue }
            if (entry.screenX < -60 || entry.screenX > width + 60 || entry.screenY < -60 || entry.screenY > height + 60) continue
            const node = entry.node
            const isSelected = store.selected !== null && store.selected === node.id
            // 三类节点分开取色：经验=主色、类型=第二停靠点、技能=高亮色。
            // 这样主题渐变（多停靠点）才看得出来，不然图上一片单色。
            const color = node.kind === 'skill' ? (palette.highlight || palette.node) : node.kind === 'suite' ? (palette.node2 || palette.node) : node.kind === 'type' ? (palette.node2 || palette.node) : palette.node
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
            const alphaBase = entry.alpha * Math.min(1, 0.2 + entry.screenF * 0.85) * breathing * energy * (related ? 1 : (isolate && focusId !== null ? 0.06 : 0.3)) * (isSelected ? 1.2 : 1)
            const screenRadius = Math.max(0.4, entry.r * entry.screenF * (0.85 + entry.currentWeight * 0.3))
            const paint = (offsetX, offsetY, alphaMultiplier) => {
              ctx.save()
              ctx.translate(entry.screenX + offsetX, entry.screenY + offsetY)
              ctx.globalAlpha = Math.max(0, Math.min(1, alphaBase * alphaMultiplier))
              ctx.shadowBlur = 0
              ctx.shadowColor = 'transparent'
              ctx.scale(breathing, breathing)
              // L3：缩到 1px 左右只画实心点，不建渐变/光晕/星芒。
              if (screenRadius <= 1.1) {
                ctx.fillStyle = color
                ctx.beginPath()
                ctx.arc(0, 0, Math.max(0.5, screenRadius), 0, Math.PI * 2)
                ctx.fill()
                ctx.restore()
                return
              }
              // 恒星感 = 白热星心 + 本体色 + 十字星芒 + 很淡的外晕。
              // 之前外晕太浓太大、星心用中间调，叠在一起就成一团发霉的污渍。
              const glowColor = palette.glow || color
              const hot = lightenColor(color, palette.dark ? 0.55 : 0.72)
              const sun = node.kind === 'root' ? (paletteKey === 'universe' ? GRAPH_SUN_UNIVERSE : paletteKey === 'cosmos' ? GRAPH_SUN_COSMOS : GRAPH_SUN_DEFAULT) : null
              const haloColor = sun ? sun.glow : glowColor
              const haloRadius = screenRadius * 2
              if (screenRadius > 2.2) {
                // 光晕和星芒用叠加混合：亮处更亮（星星是发光体），
                // 浅色主题上也不会叠出一片脏兮兮的暗晕。
                ctx.save()
                ctx.globalCompositeOperation = 'lighter'
                const halo = ctx.createRadialGradient(0, 0, screenRadius * 0.34, 0, 0, haloRadius)
                halo.addColorStop(0, withAlpha(haloColor, 0.3))
                halo.addColorStop(0.42, withAlpha(haloColor, 0.1))
                halo.addColorStop(1, withAlpha(haloColor, 0))
                ctx.fillStyle = halo
                ctx.beginPath()
                ctx.arc(0, 0, haloRadius, 0, Math.PI * 2)
                ctx.fill()
                // 小星点只给光晕，大一点的才加星芒，免得缩远后一片刺
                if (screenRadius > 3.2) drawStarFlare(ctx, screenRadius * 2.6, haloColor, 0.26)
                ctx.restore()
              }
              // 中心主星：外面一层日冕 + 8 条缓慢旋转的恒星芒，里面保留二十面体晶壳。
              if (node.kind === 'root') {
                const corona = ctx.createRadialGradient(0, 0, screenRadius * 0.2, 0, 0, screenRadius * 4.6)
                corona.addColorStop(0, withAlpha(sun.hot, 0.36))
                corona.addColorStop(0.42, withAlpha(sun.glow, 0.16))
                corona.addColorStop(1, withAlpha(sun.glow, 0))
                ctx.save()
                ctx.globalCompositeOperation = 'lighter'
                ctx.fillStyle = corona
                ctx.beginPath()
                ctx.arc(0, 0, screenRadius * 4.6, 0, Math.PI * 2)
                ctx.fill()
                if (paletteKey === 'universe') drawStarRays(ctx, screenRadius * 5.2, sun.ray, 0.5, entry.spinAngle * 0.35)
                else drawCameraSunBars(ctx, screenRadius, GRAPH_SUN_BAR, store.t)
                ctx.restore()
              }
              // 正多面体：发光线框 + 半透明面；技能/经验缩小后仍退回 2D 轮廓。
              const solid = graphSolidForNode(node)
              const poly = solid && screenRadius > 2.8 && (node.kind === 'type' || node.kind === 'suite' || node.kind === 'root' || isSelected || (node.kind === 'skill' && screenRadius > 4.2)) && (isSelected || polyBudget > 0)
              if (poly) {
                polyBudget -= 1
                drawPolyhedron(ctx, screenRadius * 1.55, color, solid, entry.spinAngle, {
                  faceAlpha: node.kind === 'root' ? 0.20 : node.kind === 'type' ? 0.38 : node.kind === 'skill' ? 0.42 : 0.42,
                  edgeAlpha: 0.95,
                  glow: true,
                })
                if (node.kind === 'root') {
                  const starCore = ctx.createRadialGradient(0, 0, 0, 0, 0, screenRadius * 1.1)
                  starCore.addColorStop(0, 'rgba(255, 255, 255, 1)')
                  starCore.addColorStop(0.35, withAlpha(sun.hot, Math.min(1, 0.75 * STAR_CORE_BOOST)))
                  starCore.addColorStop(1, withAlpha(sun.hot, 0))
                  ctx.save()
                  ctx.globalCompositeOperation = 'lighter'
                  ctx.fillStyle = starCore
                  ctx.beginPath()
                  ctx.arc(0, 0, screenRadius * 1.1, 0, Math.PI * 2)
                  ctx.fill()
                  // 白热核心再叠一层，中央光点大约亮 0.5 倍。
                  ctx.globalAlpha = 0.95
                  ctx.fillStyle = '#ffffff'
                  ctx.beginPath()
                  ctx.arc(0, 0, Math.max(1, screenRadius * 0.42), 0, Math.PI * 2)
                  ctx.fill()
                  ctx.restore()
                }
                if (screenRadius > 1.4) {
                  ctx.fillStyle = 'rgba(255, 255, 255, .95)'
                  ctx.beginPath()
                  ctx.arc(0, 0, Math.max(0.8, screenRadius * 0.32), 0, Math.PI * 2)
                  ctx.fill()
                }
                ctx.restore()
                return
              }
              const core = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(0.6, screenRadius))
              core.addColorStop(0, withAlpha(hot, 0.98))
              core.addColorStop(0.5, withAlpha(color, 0.96))
              // 边缘留一点实色，别糊成一团：星星是「亮点 + 星芒」，不是一团雾
              core.addColorStop(1, withAlpha(color, 0.72))
              ctx.fillStyle = core
              ctx.strokeStyle = withAlpha(palette.highlight || color, 0.85)
              ctx.lineWidth = isSelected ? 1.6 : 0.6
              drawGraphShape(ctx, screenRadius, node.kind)
              if (screenRadius > 1.6) {
                // 星心那一点高光：整颗星最亮的位置，定出「光源在中心」
                ctx.fillStyle = withAlpha(hot, 0.95)
                ctx.beginPath()
                ctx.arc(0, 0, Math.max(0.7, screenRadius * 0.34), 0, Math.PI * 2)
                ctx.fill()
              }
              if (node.kind === 'skill' || node.kind === 'suite') {
                ctx.beginPath()
                ctx.arc(0, 0, screenRadius * (node.kind === 'suite' ? 2.2 : 1.9), 0, Math.PI * 2)
                ctx.strokeStyle = color
                ctx.lineWidth = node.kind === 'suite' ? 1.1 : 0.9
                if (node.kind === 'suite') ctx.setLineDash([3, 2.4])
                ctx.stroke()
                if (node.kind === 'suite') ctx.setLineDash([])
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
          ctx.font = '11px ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
          const candidates = []
          const seenLabels = new Set()
          const addLabel = (entry, priority) => {
            if (!entry || entry.alpha < 0.1 || seenLabels.has(entry.node.id)) return
            seenLabels.add(entry.node.id)
            candidates.push({ entry, priority })
          }
          addLabel(store.selected === null ? null : store.nodes.get(store.selected), 0)
          addLabel(store.hovered === null ? null : store.nodes.get(store.hovered), 0)
          for (const entry of store.nodes.values()) {
            if (entry.node.kind === 'type') addLabel(entry, 1)
            else if (entry.node.kind === 'suite') addLabel(entry, 2)
            else if (entry.node.kind === 'experience' && entry.screenF > 1.05 && entry.currentWeight >= 0.5) addLabel(entry, 3)
          }
          candidates.sort((left, right) => left.priority - right.priority || right.entry.currentWeight - left.entry.currentWeight)
          const placedLabels = []
          let labelCount = 0
          for (const candidate of candidates) {
            if (labelCount >= 40) break
            const entry = candidate.entry
            const raw = String(entry.node.label || entry.node.id || '')
            if (raw === '') continue
            const label = raw.length > 26 ? `${raw.slice(0, 25)}…` : raw
            const textWidth = ctx.measureText(label).width
            const x = Math.max(6, Math.min(width - textWidth - 20, entry.screenX + Math.max(8, entry.r * entry.screenF) + 6))
            const y = Math.max(6, Math.min(height - 30, entry.screenY - 10))
            const box = { x: x - 2, y: y - 2, w: textWidth + 18, h: 24 }
            if (placedLabels.some((other) => box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y)) continue
            placedLabels.push(box)
            labelCount += 1
            ctx.save()
            ctx.globalAlpha = 0.94
            ctx.fillStyle = palette.dark ? 'rgba(10, 14, 24, .86)' : 'rgba(255, 255, 255, .94)'
            ctx.strokeStyle = palette.dark ? 'rgba(255, 255, 255, .18)' : 'rgba(15, 23, 42, .14)'
            ctx.lineWidth = 1
            ctx.beginPath()
            if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, textWidth + 14, 20, 6)
            else ctx.rect(x, y, textWidth + 14, 20)
            ctx.fill()
            ctx.stroke()
            ctx.fillStyle = palette.dark ? '#f1f5f9' : '#0f172a'
            ctx.fillText(label, x + 7, y + 14)
            ctx.restore()
          }
          ctx.globalAlpha = 1
          ctx.shadowBlur = 0
          raf = requestAnimationFrame(draw)
        }
        raf = requestAnimationFrame(draw)
        return () => {
          cancelAnimationFrame(raf)
          window.removeEventListener('resize', onResize)
          document.removeEventListener('fullscreenchange', onFullscreen)
          window.removeEventListener('pointermove', onPointerMove)
          window.removeEventListener('pointerup', onPointerUp)
          if (themeObserver !== null) themeObserver.disconnect()
          if (visibilityObserver !== null) visibilityObserver.disconnect()
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointerleave', onPointerLeave)
          canvas.removeEventListener('wheel', onWheel)
          canvas.removeEventListener('touchstart', onTouchStart)
          canvas.removeEventListener('touchmove', onTouchMove)
          canvas.removeEventListener('touchend', onTouchEnd)
          canvas.removeEventListener('touchcancel', onTouchEnd)
        }
      }, [viewData, settings.data, paused, isolate])
      const surfaceStyle = paletteNow === 'universe'
        ? { background: 'radial-gradient(circle at 50% 45%, #0a2a3d 0%, #04121d 52%, #010307 100%)' }
        : paletteNow === 'cosmos'
        ? { background: 'radial-gradient(circle at 50% 42%, #1b264d 0%, #07142f 52%, #000714 100%)' }
        : paletteNow === 'codex' && surfaceNow === 'theme'
          ? { background: 'radial-gradient(circle at 50% 42%, #1a1438 0%, #0d0b26 55%, #050418 100%)' }
          : surfaceNow === 'dark'
            ? { background: '#0b1020' }
            : surfaceNow === 'light' ? { background: '#f6f8fc' } : undefined
      const typeNodes = graph.data && Array.isArray(graph.data.nodes) ? graph.data.nodes.filter((node) => node.kind === 'type') : []
      const focusedTypeNode = focusedType === null ? null : (typeNodes.find((node) => node.id === focusedType) || null)
      const graphSummary = graph.data && graph.data.summary ? graph.data.summary : null
      const zoomBy = (factor) => { if (zoomRef.current) zoomRef.current(factor) }
      const cycleNode = (direction) => {
        const nodes = (viewData && Array.isArray(viewData.nodes) ? viewData.nodes : []).filter((node) => node.kind !== 'root')
        if (nodes.length === 0) return
        const index = nodes.findIndex((node) => selection !== null && node.id === selection.id)
        const next = nodes[(index + direction + nodes.length) % nodes.length]
        selectNode(next)
      }
      return h('div', {
        ref: wrapRef,
        className: 'eng-graph-canvas-wrap',
        style: surfaceStyle,
        tabIndex: 0,
        role: 'group',
        'aria-label': '关系图；方向键切换节点，/ 搜索，+/- 缩放，0 适配，空格暂停',
        onKeyDown: (event) => {
          if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'BUTTON')) return
          if (event.key === '+' || event.key === '=') { zoomBy(0.9); event.preventDefault() }
          else if (event.key === '-') { zoomBy(1.1); event.preventDefault() }
          else if (event.key === '0') { if (fitRef.current) fitRef.current(); event.preventDefault() }
          else if (event.key === ' ') { setPaused((value) => !value); event.preventDefault() }
          else if (event.key === 'ArrowRight') { cycleNode(1); event.preventDefault() }
          else if (event.key === 'ArrowLeft') { cycleNode(-1); event.preventDefault() }
          else if (event.key === 'Escape') {
            if (panelOpen) { setPanelOpen(false); return }
            stateRef.current.selected = null
            setSelection(null)
            setIsolate(false)
          }
          else if (event.key === 'i' || event.key === 'I') { if (selection !== null) setIsolate((value) => !value) }
          else if (event.key === '/') { setPanelOpen(true); event.preventDefault() }
        },
      },
        h('canvas', { ref: canvasRef, className: 'eng-graph-canvas', 'aria-label': '3D 记忆海' }),
        h('button', {
          className: 'eng-graph-fullscreen',
          type: 'button',
          title: fullscreen ? '退出全屏' : '全屏',
          'aria-label': fullscreen ? '退出全屏' : '全屏',
          'aria-pressed': fullscreen ? 'true' : 'false',
          onClick: toggleFullscreen,
        }, h(NavIcon, { name: fullscreen ? 'collapse' : 'expand' })),
        h('button', {
          className: 'eng-graph-drawer-toggle',
          type: 'button',
          'aria-expanded': panelOpen ? 'true' : 'false',
          'aria-controls': 'eng-graph-settings',
          title: '关系图设置（快捷键 / 搜索）',
          onClick: () => setPanelOpen((value) => !value),
        }, panelOpen ? '收起设置' : '关系图设置'),
        panelOpen ? h('div', {
          id: 'eng-graph-settings',
          className: 'eng-graph-drawer',
          role: 'dialog',
          'aria-label': '关系图设置',
          onKeyDown: (event) => { if (event.key === 'Escape') { setPanelOpen(false); event.stopPropagation() } },
        },
          h('div', { className: 'eng-graph-drawer-head' },
            h('strong', null, '关系图设置'),
            h('button', { type: 'button', className: 'eng-graph-drawer-close', onClick: () => setPanelOpen(false), 'aria-label': '关闭设置' }, '关闭')),
          h('div', { className: 'eng-graph-search' },
            h('input', {
              ref: searchRef,
              className: 'eng-input eng-graph-search-input',
              placeholder: '搜索节点（Enter 跳转）',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  if (searchHits[0]) { selectNode(searchHits[0]); setQuery('') }
                  event.preventDefault()
                } else if (event.key === 'Escape') { setQuery(''); setPanelOpen(false); event.stopPropagation() }
              },
            }),
            query.trim() !== '' ? h('div', { className: 'eng-graph-search-hits' },
              searchHits.length === 0
                ? h('div', { className: 'eng-muted', style: { padding: '6px 8px' } }, '没有匹配节点')
                : searchHits.map((node) => h('button', {
                  key: node.id,
                  type: 'button',
                  className: 'eng-graph-search-hit',
                  onClick: () => { selectNode(node); setQuery('') },
                }, `${node.label || node.id} · ${node.kind}`))) : null),
          h('div', { className: 'eng-graph-drawer-label' }, '筛选'),
          h('div', { className: 'eng-graph-filters', role: 'group', 'aria-label': '关系图类型筛选' },
            [['all', '全部'], ['experience', '经验'], ['skill', '技能'], ['type', '类型'], ['suite', '套件']].map(([key, label]) => h('button', {
              key,
              type: 'button',
              'data-active': kindFilter === key ? 'true' : 'false',
              onClick: () => setKindFilter(key),
            }, label))),
          h('div', { className: 'eng-graph-filters', role: 'group', 'aria-label': '关系图结果筛选' },
            [['all', '全部结果'], ['success', '成功'], ['partial', '部分'], ['failed', '失败'], ['unknown', '未知']].map(([key, label]) => h('button', {
              key,
              type: 'button',
              'data-active': resultFilter === key ? 'true' : 'false',
              onClick: () => setResultFilter(key),
            }, label)),
            h('button', {
              type: 'button',
              'data-active': recentOnly ? 'true' : 'false',
              'aria-pressed': recentOnly ? 'true' : 'false',
              onClick: () => setRecentOnly((value) => !value),
            }, '最近 30 天')),
          h('div', { className: 'eng-graph-drawer-label' }, '视图'),
          h('div', { className: 'eng-graph-filters', role: 'group', 'aria-label': '关系图视图' },
            h('button', { type: 'button', onClick: () => { if (fitRef.current) fitRef.current() } }, '适配视图'),
            h('button', { type: 'button', 'data-active': paused ? 'true' : 'false', onClick: () => setPaused((value) => !value) }, paused ? '继续旋转' : '暂停旋转'),
            h('button', { type: 'button', 'data-active': simple ? 'true' : 'false', 'aria-pressed': simple ? 'true' : 'false', onClick: () => setSimple((value) => !value) }, '精简视图'),
            selection === null ? null : h('button', { type: 'button', 'data-active': isolate ? 'true' : 'false', 'aria-pressed': isolate ? 'true' : 'false', onClick: () => setIsolate((value) => !value) }, isolate ? '显示全部' : '只看邻居')),
          h('div', { className: 'eng-graph-drawer-label' }, '图例'),
          graphSummary ? h('div', { className: 'eng-muted' }, `${graphSummary.types} 类 · ${graphSummary.experiences} 条经验 · ${graphSummary.skills} 个技能 · ${graphSummary.suites} 个套件`) : null,
          h('div', { className: 'eng-graph-legend-inline' }, typeNodes.slice(0, 10).map((node) => h('button', {
            key: node.id,
            type: 'button',
            className: 'eng-graph-legend-btn',
            'data-active': focusedType === node.id ? 'true' : 'false',
            'aria-pressed': focusedType === node.id ? 'true' : 'false',
            title: `只看「${node.label || node.id}」：本类节点 + 本类经验 + 相关边（再点一次恢复）`,
            onClick: () => setFocusedType((current) => (current === node.id ? null : node.id)),
          },
          h('span', { className: 'eng-legend-dot' }),
          h('span', { className: 'eng-row-intent', title: node.label }, node.label || node.id),
          h('span', { className: 'eng-mono' }, String(node.count || 0))))),
          h('div', { className: 'eng-graph-drawer-label' }, '外观'),
          h('div', { className: 'eng-graph-filters', role: 'group', 'aria-label': '关系图背景深浅' },
            [['theme', '跟随主题'], ['light', '浅色'], ['dark', '深色']].map(([key, label]) => h('button', {
              key,
              type: 'button',
              'data-active': surfaceNow === key ? 'true' : 'false',
              onClick: () => pickSurface(key),
            }, label))),
          h('div', { className: 'eng-graph-filters', role: 'group', 'aria-label': '关系图配色' },
            [['codex', '默认主题'], ['universe', '超能量体'], ['cosmos', '宇宙'], ['dsh', '跟随主题']].map(([key, label]) => h('button', {
              key,
              type: 'button',
              'data-active': paletteNow === key ? 'true' : 'false',
              onClick: () => pickPalette(key),
            }, label)))) : null,
        h('ul', { className: 'eng-visually-hidden', 'aria-label': '关系图节点列表' },
          (viewData && Array.isArray(viewData.nodes) ? viewData.nodes : [])
            .filter((node) => node.kind !== 'root')
            .slice(0, 300)
            .map((node) => h('li', { key: node.id },
              h('button', { type: 'button', onClick: () => selectNode(node) }, `${node.label || node.id}（${({ type: '类型', suite: '套件', skill: '技能', experience: '经验' })[node.kind] || node.kind}）`)))),
        (graph.error || (graph.data && graph.data.storeError))
          ? h('div', { style: { position: 'absolute', left: 14, top: 14, right: 14, zIndex: 3 } },
            h(Banner, { bad: true }, graph.error || `经验数据读取失败：${graph.data.storeError.message}${graph.data.storeError.file ? `（${graph.data.storeError.file}）` : ''}`))
          : null,
        (graph.data && (graph.data.nodes.length > viewData.nodes.length || viewData.truncated || allowAll))
          ? h('div', { className: 'eng-graph-note' },
            h('span', null, `${focusedTypeNode ? `只看「${focusedTypeNode.label || focusedTypeNode.id}」 · ` : ''}${allowAll && !viewData.truncated && viewData.nodes.length === graph.data.nodes.length
              ? `已显示全部 ${viewData.nodes.length} 个节点`
              : `已显示 ${viewData.nodes.length} / ${graph.data.nodes.length}${viewData.truncated ? `（上限 ${GRAPH_NODE_CAP}）` : ''}`}`),
            (viewData.truncated || allowAll)
              ? h('button', {
                type: 'button',
                className: 'eng-graph-note-btn',
                title: allowAll
                  ? '恢复 1,200 节点上限'
                  : (graph.data.nodes.length > GRAPH_NODE_CAP ? '大图可能掉帧：一次渲染全部节点' : '加载全部节点'),
                onClick: () => setAllowAll((value) => !value),
              }, allowAll ? `恢复 ${GRAPH_NODE_CAP}` : '加载全部')
              : null)
          : null,
        selection === null ? null : h('div', { className: 'eng-graph-detail' },
          h('div', { className: 'eng-graph-detail-meta' }, h(Badge, { tone: selection.kind === 'skill' ? 'warn' : selection.kind === 'suite' ? 'brand' : selection.kind === 'type' ? 'brand' : outcomeOf(selection.outcome)[1] }, selection.kind === 'type' ? '类型' : selection.kind === 'suite' ? '套件' : selection.kind === 'skill' ? '技能' : '经验')),
          h('h3', { className: 'eng-graph-detail-title' }, selection.label || selection.id),
          h('dl', { className: 'eng-kv' },
            selection.kind === 'experience' ? h('dt', null, '结果') : null,
            selection.kind === 'experience' ? h('dd', null, `${outcomeOf(selection.outcome)[0]} · G ${fmtNumber(selection.G)}`) : null,
            selection.kind === 'skill' ? h('dt', null, '使用') : null,
            selection.kind === 'skill' ? h('dd', null, `uses ${selection.uses || 0} · helped ${selection.helped || 0} · hurt ${selection.hurt || 0}`) : null,
            selection.kind === 'skill' && (selection.childCount || 0) > 0 ? h('dt', null, '子技能') : null,
            selection.kind === 'skill' && (selection.childCount || 0) > 0 ? h('dd', null, String(selection.childCount)) : null,
            selection.kind === 'suite' ? h('dt', null, '子技能数') : null,
            selection.kind === 'suite' ? h('dd', null, String(selection.count || 0)) : null,
            selection.kind === 'type' ? h('dt', null, '经验数') : null,
            selection.kind === 'type' ? h('dd', null, String(selection.count || 0)) : null,
            h('dt', null, 'id'), h('dd', { className: 'eng-mono' }, String(selection.id || '').replace(/^(exp|skill|type|suite):/, '')))))
    }

    function Settings(props) {
      const settings = useLoad(useCallback(() => request('/settings'), []))
      useRefreshEvent(settings.reload)
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
      const [pushConflict, setPushConflict] = useState(null)
      const repoInputRef = useRef(null)
      const [section, setSection] = useState(props && props.section ? String(props.section) : 'storage')
      const [density, setDensity] = useState(() => {
        try { return localStorage.getItem('eng:density') === 'compact' ? 'compact' : 'comfortable' } catch { return 'comfortable' }
      })
      // 密度只作用于本机显示：写 localStorage，并直接改根节点，不重载插件。
      const saveDensity = (value) => {
        const next = value === 'compact' ? 'compact' : 'comfortable'
        setDensity(next)
        try { localStorage.setItem('eng:density', next) } catch { /* 隐私模式忽略 */ }
        try {
          if (typeof document !== 'undefined') {
            const root = document.querySelector('.eng-app')
            if (root !== null) root.setAttribute('data-density', next)
          }
        } catch { /* 测试环境没有 document */ }
      }
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
            } else if (pushResult.needsDecision) {
              setPushConflict(pushResult)
              setGhNotice(`${label}：远端有本机没有的提交，等你决定`)
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
        if (action === 'push') {
          await runPush({})
          return
        }
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
      /**
       * 统一推送入口：碰到「远端有本机没有的提交」时抛给弹窗决定，
       * 覆盖 = force 再推一次；另建分支 = 换个目标分支再推。
       */
      const runPush = async (options = {}) => {
        setBusy(true); setSyncNotice('')
        try {
          const body = { action: 'push' }
          if (options.force === true) body.force = true
          if (options.branch) body.branch = options.branch
          const result = await request('/sync', { method: 'POST', body })
          await sync.reload()
          if (result && result.needsDecision) {
            setPushConflict(result)
            setSyncNotice(result.reason || '远端有本机没有的提交')
            return
          }
          const reason = result && typeof result.reason === 'string' ? result.reason : ''
          const overwriteNote = result && result.overwrote
            ? `（用本地覆盖了远端${result.backupRef ? `；旧远端 HEAD 存在 ${result.backupRef}` : ''}）`
            : ''
          setSyncNotice(reason === '' ? `同步完成${overwriteNote}` : `同步：${reason}`)
        } catch (caught) {
          setSyncNotice(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      const resolvePushConflict = async (choice) => {
        const conflict = pushConflict
        setPushConflict(null)
        if (choice === 'switch') {
          setSyncNotice('选一个仓库或粘贴地址，再点「连接并同步」')
          if (repoInputRef.current && typeof repoInputRef.current.focus === 'function') repoInputRef.current.focus()
          return
        }
        if (choice === 'overwrite') {
          await runPush({ force: true })
          return
        }
        // 另建分支：推到新分支上，原分支不动；成功后把备份目标改成新分支。
        const stamp = new Date()
        const pad = (value) => String(value).padStart(2, '0')
        const name = `engram-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
        try {
          await request('/settings', { method: 'POST', body: { git: { ...gitDraft, branch: name } } })
          setGitDraft({ ...gitDraft, branch: name })
          await settings.reload()
        } catch (caught) {
          setSyncNotice(caught.message || String(caught))
          return
        }
        await runPush({ branch: name })
        if (conflict) setSyncNotice(`已推到新分支 ${name}；原分支保持原样`)
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
      const saveRoot = async (value, note) => {
        setBusy(true); setNotice('')
        try {
          await request('/settings', { method: 'POST', body: { currentRoot: value } })
          setNotice(value === '' ? '已恢复默认目录' : `已切换存储位置${note ? `（${note}）` : ''}`)
          await Promise.all([settings.reload(), validation.reload()])
          if (props.onChanged) props.onChanged()
        } catch (caught) {
          setNotice(caught.message || String(caught))
        } finally {
          setBusy(false)
        }
      }
      // 「选择文件夹」：弹宿主自己的系统选目录窗口（跟选工作区同一个），选完直接用。
      // 宿主没有窗口能力（远程浏览器等）时退回手填路径，不假装点过窗口。
      const pickRoot = async () => {
        setNotice(''); setBusy(true)
        let picked = null
        try {
          picked = await request('/pick-directory', { method: 'POST' })
        } catch (caught) {
          setNotice(caught.message || String(caught))
          setBusy(false)
          return
        }
        setBusy(false)
        if (!picked || picked.canceled === true || String(picked.path || '').trim() === '') {
          setNotice('没选目录，位置没变')
          return
        }
        setRootInput(picked.path)
        await saveRoot(picked.path, picked.note)
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
      const storage = data.storage !== null && typeof data.storage === 'object' ? data.storage : null
      const legacy = storage !== null && storage.legacy !== null && typeof storage.legacy === 'object' ? storage.legacy : null
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
          h('div', { className: 'eng-muted', style: { marginBottom: 10 } }, '经验库根目录（含 exp-lib.json / manifest.json 的那个目录）。点「选择文件夹…」在系统窗口里挑；也可以直接粘贴路径后回车。'),
          h('div', { className: 'eng-actions', style: { marginBottom: 10 } },
            h('input', {
              className: 'eng-input',
              style: { flex: '1 1 320px' },
              value: rootInput,
              onChange: (event) => setRootInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' || busy) return
                event.preventDefault()
                if (rootInput.trim() !== '') saveRoot(rootInput.trim())
              },
              placeholder: '例如：C:/Users/yh/WorkDeepSeek/.exp',
            }),
            h(Button, { kind: 'primary', disabled: busy, onClick: pickRoot }, '选择文件夹…'),
            rootInput.trim() !== '' && rootInput.trim() !== String(data.currentRoot || '')
              ? h(Button, { disabled: busy, onClick: () => saveRoot(rootInput.trim()) }, '用这个路径')
              : null,
            h(Button, { disabled: busy, onClick: () => saveRoot('') }, '恢复默认')),
          notice ? h(Banner, null, notice) : null,
          h('dl', { className: 'eng-kv' },
            h('dt', null, '当前根'), h('dd', { className: 'eng-mono' }, data.currentRoot || '（未设置，用默认）'),
            h('dt', null, '生效目录'), h('dd', { className: 'eng-mono' }, data.dataDir || '—'),
            h('dt', null, '经验库文件'), h('dd', { className: 'eng-mono' }, data.file || '—'),
            h('dt', null, '大小'), h('dd', null, fmtBytes(data.bytes)),
            h('dt', null, '版本'), h('dd', null, data.version || '—'))),
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '存储结构'),
          storage === null
            ? h('div', { className: 'eng-muted' }, '暂无存储信息（还没读到 manifest）')
            : h('div', null,
              h('dl', { className: 'eng-kv' },
                h('dt', null, 'manifest'), h('dd', { className: 'eng-mono' }, fmtBytes(storage.manifestBytes)),
                h('dt', null, '分片'), h('dd', null, `${storage.bucketFiles || 0} 个文件 · ${fmtBytes(storage.bucketBytes)}`),
                h('dt', null, '冷档'), h('dd', null, Number(storage.coldFiles) > 0 ? `${storage.coldFiles} 个文件 · ${fmtBytes(storage.coldBytes)}` : '暂无（安全阀未触发）'),
                h('dt', null, 'legacy'), h('dd', null, legacy && legacy.exists ? `${fmtBytes(legacy.bytes)} · 迁移前快照，可删` : '无'),
                h('dt', null, '总计'), h('dd', null, `${fmtBytes(storage.totalBytes)} · ${storage.fileCount || 0} 个文件`))))
      ] : null,
        section === 'backup' ? [
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, 'Git 同步'),
          h('div', { className: 'eng-muted', style: { marginBottom: 12 } }, '把经验库当普通 git 仓库同步到远端：只提交当前数据目录，拉取只做 fast-forward，冲突交回给人。选好仓库就等于连上了，不用再点第二次。'),
          h('div', { className: 'eng-git-status' },
            h(Badge, { tone: connectedNow ? 'ok' : 'muted' }, connectedNow ? '已连接' : '未连接'),
            h('span', { className: 'eng-mono', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, connectedNow ? gitUrlNow : '选一个仓库，或填地址连接'),
            h('span', { className: 'eng-muted' }, `分支 ${branchNow}`),
            h('span', { className: 'eng-muted' }, String(gitDraft.pushStrategy || 'overwrite') === 'fast-forward' ? '策略：只允许快进' : String(gitDraft.pushStrategy || 'ask') === 'ask' ? '策略：远端有新提交时问我' : '策略：本地覆盖云端'),
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
            h('input', { ref: repoInputRef, className: 'eng-input', style: { flex: '1 1 280px' }, placeholder: 'https://github.com/<你>/<仓库>.git', value: gitDraft.repoUrl || '', onChange: (event) => setGitDraft({ ...gitDraft, repoUrl: event.target.value }) }),
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
          sync.error ? h(Banner, { bad: true }, sync.error) : null,
          pushConflict
            ? h(PushConflictDialog, {
              conflict: pushConflict,
              busy,
              onClose: () => setPushConflict(null),
              onOverwrite: () => resolvePushConflict('overwrite'),
              onNewBranch: () => resolvePushConflict('branch'),
              onSwitchRepo: () => resolvePushConflict('switch'),
            })
            : null)
        ] : null,

        section === 'ui' ? [
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '界面与关系图'),
          h('div', { className: 'eng-form-grid' }, renderFields(spec.ui, uiDraft, setUiDraft)),
          h('div', { className: 'eng-muted', style: { marginBottom: 8 } }, '外观跟随 DSH 主题：白底 + 蓝强调 + 灰点缀；切换浅色 / 深色或换肤会自动生效。'),
          h('div', { className: 'eng-field' },
            h('label', { className: 'eng-label' }, '界面密度'),
            h('select', { className: 'eng-select', value: density, onChange: (event) => saveDensity(event.target.value) },
              h('option', { value: 'comfortable' }, '舒适（行 36px）'),
              h('option', { value: 'compact' }, '紧凑（行 30px）')),
            h('span', { className: 'eng-muted' }, '只改本机显示，保存后立即生效；字号与圆角不随密度变。')),
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
      ['cold', '冷档', 'archive'],
      ['usage', '使用记录', 'clock'],
      ['settings', '设置', 'gear'],
    ]

    const NAV_GROUPS = [
      ['总览', ['overview', 'graph']],
      ['数据', ['experiences', 'types', 'cold']],
      ['动作', ['recall', 'record', 'skills']],
      ['系统', ['usage', 'settings']],
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
      const [focusId, setFocusId] = useState(null)
      const [density] = useState(() => {
        try { return localStorage.getItem('eng:density') === 'compact' ? 'compact' : 'comfortable' } catch { return 'comfortable' }
      })
      const [recallSeed, setRecallSeed] = useState('')
      const rootRef = useRef(null)
      const [fitHeight, setFitHeight] = useState(null)
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [refreshing, setRefreshing] = useState(false)
      const [importNotice, setImportNotice] = useState('')
      const [refreshedAt, setRefreshedAt] = useState('')
      const [reloadToken, setReloadToken] = useState(0)
      // 「添加技能」弹层：只在技能页出现，放在顶部右侧、版本号左边。
      const [importOpen, setImportOpen] = useState(false)
      const [paletteOpen, setPaletteOpen] = useState(false)
      const [shortcutsOpen, setShortcutsOpen] = useState(false)
      const [toasts, setToasts] = useState([])
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
          // 不重挂页面：各页监听 eng-refresh 自己 reload，选中与滚动都保留。
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('eng-refresh'))
        } finally {
          setRefreshing(false)
        }
      }, [loadState])
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const handler = (event) => {
          const detail = event && event.detail ? event.detail : {}
          const id = `${Date.now()}-${Math.random()}`
          const item = { id, message: String(detail.message || ''), tone: detail.tone === 'bad' ? 'bad' : 'ok' }
          setToasts((previous) => [...previous, item].slice(-3))
          setTimeout(() => setToasts((previous) => previous.filter((toastItem) => toastItem.id !== id)), 4000)
        }
        window.addEventListener('eng-toast', handler)
        return () => window.removeEventListener('eng-toast', handler)
      }, [])
      const goRef = useRef(0)
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const handler = (event) => {
          const tag = event.target && event.target.tagName ? String(event.target.tagName) : ''
          const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag)
          if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
            event.preventDefault()
            setPaletteOpen((open) => !open)
            return
          }
          if (event.key === 'Escape') {
            setPaletteOpen(false)
            setShortcutsOpen(false)
            return
          }
          if (typing) return
          if (event.key === '?') {
            event.preventDefault()
            setShortcutsOpen(true)
            return
          }
          if (event.shiftKey && String(event.key).toLowerCase() === 'r') {
            event.preventDefault()
            refreshAll()
            return
          }
          if (String(event.key).toLowerCase() === 'g') {
            goRef.current = Date.now()
            return
          }
          if (Date.now() - goRef.current < 1200) {
            const map = { o: 'overview', e: 'experiences', r: 'recall', n: 'record', s: 'skills', t: 'types', u: 'usage', ',': 'settings' }
            const target = map[String(event.key).toLowerCase()]
            if (target !== undefined) {
              event.preventDefault()
              goRef.current = 0
              setTab(target)
            }
          }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
      }, [refreshAll])
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
      // 主题强调色：默认皮肤用 DSH 蓝，彩色主题跟随 brand-primary；主题切换时重算。
      useEffect(() => {
        const node = rootRef.current
        if (node === null || typeof document === 'undefined' || typeof getComputedStyle !== 'function') return undefined
        const apply = () => {
          try {
            const probe = document.createElement('span')
            probe.style.display = 'none'
            node.appendChild(probe)
            probe.style.color = 'var(--dsw-alias-brand-primary)'
            const brand = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)
            const body = document.body
            const isDark = Boolean(body && (body.hasAttribute('data-ds-dark-theme') || body.getAttribute('data-theme') === 'dark'))
              || Boolean(document.documentElement && document.documentElement.getAttribute('data-theme') === 'dark')
            const accent = pickAccent(brand, isDark)
            node.style.setProperty('--eng-accent', accent)
            node.style.setProperty('--eng-accent-fill', accent)
            probe.style.color = 'var(--eng-accent-strong)'
            const fill = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)
            probe.remove()
            if (fill.length < 3) return
            const [r, g, b] = fill.map((value) => {
              const channel = value / 255
              return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
            })
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            node.style.setProperty('--eng-on-brand', lum > 0.19 ? '#0d0f12' : '#ffffff')
          } catch {
            // 拿不到主题色就保留 CSS 默认（DSH 蓝 + 白字）
          }
        }
        apply()
        if (typeof MutationObserver !== 'function') return undefined
        const observers = []
        const observe = (target, options) => {
          if (target === null || target === undefined) return
          const observer = new MutationObserver(apply)
          observer.observe(target, options)
          observers.push(observer)
        }
        // 主题可能改 html/body 的任意属性（如 data-dsh-cyrene / data-cyrene-skin），不能只盯 class/style。
        observe(document.documentElement, { attributes: true })
        observe(document.body, { attributes: true })
        observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'media'] })
        return () => { for (const observer of observers) observer.disconnect() }
      }, [])
      const counts = {
        experiences: state ? state.totals.visible : null,
        skills: state ? state.totals.skills : null,
        types: state ? state.totals.types : null,
        cold: state && state.cold ? Number(state.cold.total) || null : null,
        usage: state && state.usage ? state.usage.total : null,
      }
      // 没有冷档就不占导航：安全阀未触发时「冷档」页没有意义。
      const coldVisible = counts.cold !== null && counts.cold > 0
      const navBlock = NAV_GROUPS.map(([label, ids]) => {
        const items = ids
          .map((id) => NAV.find((entry) => entry[0] === id))
          .filter((entry) => entry !== undefined && (entry[0] !== 'cold' || coldVisible))
        if (items.length === 0) return null
        return h('div', { className: 'eng-nav-group', key: label },
          h('div', { className: 'eng-nav-group-label' }, label),
          items.map(navButton))
      })
      const go = (next) => setTab(next)
      const content = (() => {
        if (tab === 'overview') return h(Overview, { state, onGo: go, onChanged: loadState, onOpen: (id) => { setFocusId(id); setTab('experiences') } })
        if (tab === 'graph') return h(Graph)
        if (tab === 'experiences') return h(Experiences, { state, focusId, onChanged: loadState, onSearch: (value) => { setRecallSeed(value); setTab('recall') } })
        if (tab === 'recall') return h(Recall, { seed: recallSeed, types: state ? state.types : [] })
        if (tab === 'record') return h(Record)
        if (tab === 'skills') return h(Skills, { onChanged: loadState })
        if (tab === 'types') return h(Types, { onChanged: loadState })
        if (tab === 'cold') return h(Cold)
        if (tab === 'usage') return h(Usage)
        return h(Settings, { onChanged: loadState })
      })()
      const source = state && state.source
      const paletteItems = [
        ...NAV.filter(([id]) => id !== 'cold' || coldVisible).map(([id, label]) => ({ id: `go-${id}`, group: '前往', label, run: () => setTab(id) })),
        { id: 'new-record', group: '动作', label: '记录经验', run: () => setTab('record') },
        { id: 'recall', group: '动作', label: '检索召回', run: () => setTab('recall') },
        { id: 'import-skill', group: '动作', label: '添加技能', run: () => { setTab('skills'); setImportOpen(true) } },
        { id: 'refresh-page', group: '动作', label: '刷新当前页', run: () => { loadState(); if (typeof window !== 'undefined') window.dispatchEvent(new Event('eng-refresh')); toast('已刷新') } },
        { id: 'reload-all', group: '工具', label: '重新加载全部页面', run: () => { loadState(); setReloadToken((token) => token + 1); toast('已重新加载') } },
        { id: 'copy-dir', group: '工具', label: '复制数据目录', run: () => { try { if (state && typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(state.dataDir || ''); toast('已复制数据目录') } catch { toast('复制失败', 'bad') } } },
        { id: 'shortcuts', group: '工具', label: '查看快捷键', run: () => setShortcutsOpen(true) },
      ]
      function navButton([id, label, icon]) {
        return h('button', {
          key: id,
          type: 'button',
          className: 'eng-nav-item',
          'data-active': tab === id ? 'true' : 'false',
          onClick: () => setTab(id),
        }, h(NavIcon, { name: icon }), label, counts[id] === null || counts[id] === undefined ? null : h('span', { className: 'eng-nav-count' }, String(counts[id])))
      }
      const brandMark = h(EngramGlyph, { size: 18 })
      return h('div', { className: 'eng-app', 'data-density': density, ref: rootRef, style: fitHeight === null ? undefined : { height: `${fitHeight}px` } },
        h('aside', { className: 'eng-rail' },
          h('div', { className: 'eng-brand' },
            h('span', { className: 'eng-brand-mark' }, brandMark),
            h('div', null, h('div', { className: 'eng-brand-name' }, TITLE), h('div', { className: 'eng-brand-sub' }, 'ENG RAM'))),
          h('nav', { className: 'eng-nav' }, navBlock),
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
            importNotice ? h(Banner, null, importNotice) : null,
            h(PageBoundary, { key: `${tab}:${reloadToken}` }, content))),
        importOpen
          ? h(ImportSkillDialog, {
            // 用户要的是「装完弹窗就消失」：导入成功 → 关弹窗 + 刷新列表（refreshAll 顺带重挂页面）。
            onClose: () => setImportOpen(false),
            onImported: (out) => {
              setImportOpen(false)
              const count = out && out.suite ? Number(out.count) || 0 : 1
              const firstPkg = out && Array.isArray(out.items) && out.items[0] ? out.items[0].package : null
              setImportNotice(`已导入${count > 1 ? `技能套件 ${count} 个技能` : '技能'}${firstPkg ? `（含 ${firstPkg.fileCount} 个文件${firstPkg.skipped > 0 ? `，跳过 ${firstPkg.skipped} 个` : ''}）` : ''}，列表已刷新`)
              refreshAll()
            },
          })
          : null,
        paletteOpen ? h(CommandPalette, { items: paletteItems, onClose: () => setPaletteOpen(false) }) : null,
        shortcutsOpen ? h(ShortcutsDialog, { onClose: () => setShortcutsOpen(false) }) : null,
        h('div', { className: 'eng-toast-host', 'aria-live': 'polite' }, toasts.map((item) => h('div', { key: item.id, className: 'eng-toast', 'data-tone': item.tone, role: 'status' }, item.message))))
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
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: hover && state !== 'busy' ? 'var(--dsw-alias-interactive-bg-hover, var(--eng-ink-8))' : 'transparent',
        color: state === 'err' ? 'var(--dsw-alias-state-error-primary, #d24b45)' : state === 'busy' ? 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' : hover ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
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
      PushConflictDialog,
      Console,
      Settings,
      Overview,
      Skills,
      Recall,
      Record,
      Types,
      Usage,
      Cold,
      pickAccent,
      layoutGraph,
      GRAPH_SOLIDS,
      GRAPH_SOLID_FOR_KIND,
      GRAPH_SUN,
      GRAPH_SUN_DEFAULT,
      GRAPH_SUN_UNIVERSE,
      GRAPH_SUN_COSMOS,
      GRAPH_SUN_BAR,
      graphSolidForNode,
      drawPolyhedron,
      CommandPalette,
      ShortcutsDialog,
      toast,
      useRefreshEvent,
      Graph,
      SaveExperienceAction,
      Tip,
      showTipLayer,
      hideTipLayer,
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
