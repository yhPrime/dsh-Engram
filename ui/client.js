/**
 * 经验库控制台（dsh-exp-ui client）
 *
 * 八个页面覆盖内核全部能力：概览 / 经验 / 检索 / 记录 / 技能 / 类型 / 使用记录 / 设置。
 * 只通过 `/exp-ui/api/*` 访问数据；mock 与 live 返回形状一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-exp-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'exp-ui'
    const PACKAGE_NAME = 'dsh-exp-ui'
    const TITLE = '经验库'
    const API = '/exp-ui/api'

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    const STYLE_ID = 'dsh-exp-ui/styles'
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
.eng-graph-canvas-wrap { position: relative; width: 100%; aspect-ratio: 16 / 9; min-height: 420px; overflow: hidden; border-radius: 12px; background: transparent; }
.eng-graph-canvas { width: 100%; height: 100%; display: block; cursor: grab; }
.eng-content-full { padding: 0; max-width: none; overflow: hidden; display: flex; }
.eng-content-full .eng-graph-canvas-wrap { flex: 1 1 auto; height: 100%; min-height: 0; aspect-ratio: auto; border-radius: 0; }
.eng-graph-detail { position: absolute; right: 14px; bottom: 14px; z-index: 2; width: min(320px, 72%); padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent); backdrop-filter: blur(10px); box-shadow: 0 10px 30px rgba(0,0,0,.14); }
.eng-graph-detail-title { font-size: 13px; font-weight: 650; margin: 0 0 6px; word-break: break-word; }
.eng-graph-detail-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
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

    const GRAPH_THEMES = ['personal', 'dream', 'knowledge', 'emotion', 'spacetime', 'collective', 'inspiration']
    const GRAPH_PALETTES = {
      dsh: {},
      cyberpunk: { bg: '#020308', bgInner: '#071023', node: '#00f0ff', node2: '#ff2bd6', edge: '#7b2cff', highlight: '#ff2bd6', warn: '#ffd166', ok: '#39ff88', bad: '#ff3b5c', glow: '#ff2bd6', dust: '#8fe9ff', bloom: 22 },
      aurora: { bg: '#010208', bgInner: '#06101a', node: '#7dffd4', node2: '#b892ff', edge: '#7cc7ff', highlight: '#c9b6ff', warn: '#ffe3a3', glow: '#9dffdf', dust: '#bfffe9', bloom: 18 },
      blackgold: { bg: '#060504', bgInner: '#141006', node: '#ffcc66', node2: '#ff9f2e', edge: '#b9852f', highlight: '#ffe3a3', warn: '#ffcf7a', glow: '#ffb84d', dust: '#ffe3a3', bloom: 16 },
      steampunk: { bg: '#0a0604', bgInner: '#1a0f08', node: '#d9a441', node2: '#b85c2a', edge: '#8a4b22', highlight: '#ffb35c', warn: '#e8c07a', glow: '#ffb35c', dust: '#e0b07a', bloom: 14 },
      qingmo: { bg: '#060909', bgInner: '#0c1614', node: '#8fd6c9', node2: '#c85a4a', edge: '#5f9e93', highlight: '#c85a4a', warn: '#d9c7a7', glow: '#a7e8dd', dust: '#cfe8e0', bloom: 12 },
      minimal: { bg: '#020305', bgInner: '#0a1017', node: '#bfe9ff', node2: '#9fb3c8', edge: '#5c7c99', highlight: '#dff4ff', warn: '#d5dee8', glow: '#a8d8ff', dust: '#9fb3c8', bloom: 6 },
      lava: { bg: '#080302', bgInner: '#1c0805', node: '#ff7a18', node2: '#ff2d2d', edge: '#8a2b12', highlight: '#ffc27a', warn: '#ffb347', glow: '#ff9a3c', dust: '#ffc27a', bloom: 24 },
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

    function readDshGraphPalette(canvas) {
      const local = getComputedStyle(canvas)
      const root = getComputedStyle(document.documentElement)
      const read = (name, fallback) => (local.getPropertyValue(name) || root.getPropertyValue(name) || '').trim() || fallback
      const bg = read('--dsw-alias-bg-layer-1', '#0b0e14')
      const bgInner = read('--dsw-alias-bg-layer-2', bg)
      const brand = read('--dsw-alias-brand-primary', '#4f7cff')
      const secondary = read('--dsw-alias-label-secondary', '#8b93a7')
      return {
        bg: bgInner === bg ? bg : bgInner,
        bgInner: bg,
        node: brand,
        node2: secondary,
        ok: read('--dsw-alias-success-primary', '#0f9d8a'),
        bad: read('--dsw-alias-error-primary', '#d1435b'),
        edge: read('--dsw-alias-border-l1', '#3a4150'),
        highlight: brand,
        warn: read('--dsw-alias-warning-primary', '#c08312'),
        glow: brand,
        dust: secondary,
        bloom: 10,
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
        selected: null, pulse: 0, t: 0, dragging: null, dragMoved: false,
      })
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !graph.data) return undefined
        const ui = (settings.data && settings.data.ui) || {}
        const paletteKey = GRAPH_PALETTES[ui.graphPalette] ? ui.graphPalette : 'dsh'
        const palette = paletteKey === 'dsh' ? readDshGraphPalette(canvas) : GRAPH_PALETTES[paletteKey]
        const theme = GRAPH_THEMES.includes(ui.graphTheme) ? ui.graphTheme : 'personal'
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
          if (node.kind === 'type') return 5 + Math.pow(w, 0.85) * 10
          if (node.kind === 'skill') return 3 + Math.pow(w, 0.9) * 4.5
          return 1.2 + Math.pow(w, 0.9) * 3.6
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
          }
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
          cam.dist = Math.min(3200, Math.max(520, cam.dist * (event.deltaY > 0 ? 1.08 : 0.92)))
        }
        resize()
        sync(graph.data)
        window.addEventListener('resize', resize)
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        canvas.addEventListener('pointerdown', onPointerDown)
        canvas.addEventListener('wheel', onWheel, { passive: false })
        canvas.style.cursor = 'grab'
        const draw = (now) => {
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
            const bright = store.selected !== null && (edgeState.edge.source === store.selected || edgeState.edge.target === store.selected)
            ctx.globalAlpha = Math.min(1, (0.025 + strength * 0.32) * near * (bright ? 1.9 : 1))
            const gradient = ctx.createLinearGradient(from.screenX, from.screenY, to.screenX, to.screenY)
            gradient.addColorStop(0, edgeState.edge.kind === 'derived' ? palette.node2 : palette.node)
            gradient.addColorStop(1, palette.edge)
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
            const color = node.kind === 'type' ? palette.node
              : node.kind === 'skill' ? palette.node2
                : node.outcome === 'failed' || node.outcome === 'corrected' || node.outcome === 'rejected' ? (palette.bad || palette.highlight)
                  : node.outcome === 'partial' ? palette.warn
                    : node.outcome === 'success' || node.outcome === 'accepted' ? (palette.ok || palette.node) : palette.node2
            const breathing = node.recent ? 1 + Math.sin(store.t * 1.8 + entry.phase) * 0.09 : 1 + Math.sin(store.t * 0.9 + entry.phase) * 0.02
            const nearFactor = Math.min(1.6, Math.max(0.35, entry.screenF))
            const alphaBase = entry.alpha * Math.min(1, 0.2 + entry.screenF * 0.85) * breathing
            const screenRadius = Math.max(0.4, entry.r * entry.screenF * (0.85 + entry.currentWeight * 0.3))
            const paint = (offsetX, offsetY, alphaMultiplier) => {
              ctx.save()
              ctx.translate(entry.screenX + offsetX, entry.screenY + offsetY)
              ctx.globalAlpha = Math.max(0, Math.min(1, alphaBase * alphaMultiplier))
              ctx.shadowBlur = bloom ? (4 + palette.bloom * 0.35 * entry.currentWeight) * nearFactor : 0
              ctx.shadowColor = color
              ctx.fillStyle = color
              ctx.strokeStyle = palette.highlight
              ctx.lineWidth = isSelected ? 1.6 : 0.6
              ctx.scale(breathing, breathing)
              drawGraphShape(ctx, screenRadius, theme)
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
          window.removeEventListener('resize', resize)
          window.removeEventListener('pointermove', onPointerMove)
          window.removeEventListener('pointerup', onPointerUp)
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('wheel', onWheel)
        }
      }, [graph.data, settings.data])
      return h('div', { className: 'eng-graph-canvas-wrap' },
        h('canvas', { ref: canvasRef, className: 'eng-graph-canvas', 'aria-label': '3D 记忆海' }),
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
            (field.values || []).map((option) => h('option', { key: option, value: option }, (field.labels && field.labels[option]) || option)))
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
          h('h3', { className: 'eng-detail-title' }, '界面与关系图'),
          h('div', { className: 'eng-form-grid' }, renderFields(spec.ui, uiDraft, setUiDraft)),
          h('div', { className: 'eng-actions' }, h(Button, { kind: 'primary', disabled: busy, onClick: () => post({ ui: uiDraft }) }, '保存数据源'))),
        h('div', { className: 'eng-card eng-detail' },
          h('h3', { className: 'eng-detail-title' }, '内核参数'),
          h('div', { className: 'eng-muted', style: { marginBottom: 10 } }, '关系图主题/配色/旋转/泛光/浮尘都在「界面与关系图」里切换；内核算力参数保存后动态生效。'),
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
          h('div', { className: tab === 'graph' ? 'eng-content eng-content-full' : 'eng-content' },
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
        } catch (error) { console.error('[exp-ui] panellist registration failed', error) }
        try {
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Console)))
        } catch (error) { console.error('[exp-ui] main panel registration failed', error) }
        try {
          disposers.push(ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, BundleCard)))
        } catch (error) { console.error('[exp-ui] bundle card registration failed', error) }
        ctx.effect(() => () => {
          for (const dispose of disposers.reverse()) {
            try { dispose() } catch (error) { console.error('[exp-ui] dispose failed', error) }
          }
        })
      },
    }
  },
})
