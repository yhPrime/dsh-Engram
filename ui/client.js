/**
 * dsh-exp-ui — Client 半（界面外壳）。
 *
 * 三处贡献：
 *   - `sidebar.panellist`  左侧栏图标「exp-ui」，点它打开主面板
 *   - `main`               经验库界面：检索、列表、类型、使用记录、详情、用后反馈
 *   - `plugins.bundle.config` 插件页卡片（数据源与规模 + 打开面板）
 *
 * 只通过 `/exp-ui/api/*` 拿数据；mock 与 live 两种数据源的返回形状一致，
 * 所以这里不分支——只读物数据里的 `source.readOnly` 决定反馈按钮是否可点。
 */
window.__ModuleLoader__.load({
  id: 'dsh-exp-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'exp-ui'
    const PACKAGE_NAME = 'dsh-exp-ui'
    const TITLE = 'exp-ui'

    /**
     * 侧栏图标用宿主自己的图标族（与「插件 / 自动化任务 / 记忆系统」那一排同一套
     * Icon* 组件），尺寸、线宽、视觉重心才一致。拿不到就退回自绘的 16 栅格线性图标。
     * 注意：侧栏那一格只放**图标**——行按钮、label、点击切面板都由宿主负责。
     */
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
      console.error('[exp-ui] primitives unavailable, using fallback icon', error)
    }

    /**
     * 悬停 / 焦点 / 窄容器这几件事用 CSS 写（内联 style 做不到）：
     * 列表行与技能卡才有 hover；窄容器里详情抽屉变成整层 + 返回按钮。
     */
    const STYLE_ID = 'dsh-exp-ui/styles'
    const PANEL_CSS = `
.exp-ui-row { transition: border-color .15s ease, background-color .15s ease; }
.exp-ui-row:hover { border-color: color-mix(in srgb, var(--dsw-alias-label-secondary) 35%, var(--dsw-alias-border-l1)); background: var(--dsw-alias-bg-layer-2); }
.exp-ui-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.exp-ui-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-secondary); }
.exp-ui-chip-on:hover { opacity: .92; }
.exp-ui-skill { transition: border-color .15s ease, background-color .15s ease; }
.exp-ui-skill:hover { border-color: color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, var(--dsw-alias-border-l1)); background: var(--dsw-alias-bg-layer-2); }
.exp-ui-skill-head { cursor: pointer; border-radius: 6px; }
.exp-ui-skill-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.exp-ui-skill-head:hover .exp-ui-skill-title { color: var(--dsw-alias-brand-primary); }
.exp-ui-usage-link { cursor: pointer; }
.exp-ui-usage-link:hover { background: var(--dsw-alias-interactive-bg-hover); }
.exp-ui-aside-back { display: none; }
@container exp-ui (max-width: 900px) {
  .exp-ui-aside { position: absolute; inset: 0; width: 100%; flex: 1 1 auto; z-index: 6; box-shadow: 0 -10px 28px rgba(0, 0, 0, .18); }
  .exp-ui-aside-back { display: inline-flex; }
}
@media (prefers-reduced-motion: reduce) { .exp-ui-row, .exp-ui-skill { transition: none; } }
`

    function ensureStyles() {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return
      if (typeof document.querySelector === 'function' && document.querySelector(`style[data-exp-ui="${STYLE_ID}"]`) !== null) return
      const style = document.createElement('style')
      style.dataset.expUi = STYLE_ID
      style.textContent = PANEL_CSS
      if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ */
    /* Host API                                                           */
    /* ------------------------------------------------------------------ */

    function apiUrl(path) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string'
        ? document.baseURI
        : 'http://dsh.internal/'
      return new URL(path.replace(/^\/+/, ''), new URL('.', base)).href
    }

    /** 调接口；失败抛带 code 的错误（后端 envelope：{ok:false,error:{code,message}}）。 */
    async function request(path, options) {
      const opts = options || {}
      const init = {
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      }
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
      const response = await fetch(apiUrl(`exp-ui/api/${path}`), init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const detail = payload && payload.error ? payload.error : {}
        const error = new Error(String(detail.message || `http-${response.status}`))
        error.code = String(detail.code || `http-${response.status}`)
        throw error
      }
      return payload.data
    }

    /* ------------------------------------------------------------------ */
    /* Formatting                                                         */
    /* ------------------------------------------------------------------ */

    const OUTCOMES = {
      success: { label: '成功', tone: 'ok' },
      accepted: { label: '通过', tone: 'ok' },
      partial: { label: '部分', tone: 'warn' },
      failed: { label: '失败', tone: 'bad' },
      corrected: { label: '被纠正', tone: 'bad' },
      rejected: { label: '被拒', tone: 'bad' },
      aborted: { label: '中止', tone: 'muted' },
      unknown: { label: '未标', tone: 'muted' },
    }

    const TOOLS = {
      exp_recall: '召回',
      exp_record: '记录',
      exp_feedback: '反馈',
      exp_consolidate: '沉淀',
      exp_type: '类型管理',
    }

    /** 固化技能状态（规则与 exp-lib highConfidence 一致）。 */
    const SKILL_STATUS = {
      solid: { label: '已固化', tone: 'ok' },
      trial: { label: '试用中', tone: 'warn' },
      risky: { label: '不稳定', tone: 'bad' },
      blocked: { label: '有未解障碍', tone: 'bad' },
      new: { label: '待验证', tone: 'muted' },
    }

    function skillStatusOf(value) {
      return SKILL_STATUS[String(value || 'new')] || SKILL_STATUS.new
    }

    function outcomeOf(value) {
      return OUTCOMES[String(value || 'unknown')] || { label: String(value || '未标'), tone: 'muted' }
    }

    function fmtBytes(bytes) {
      const size = Number(bytes) || 0
      if (size < 1024) return `${size} B`
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
      return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function fmtTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fmtShortTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fmtNumber(value, digits) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return number.toFixed(digits === undefined ? 2 : digits)
    }

    function truncate(text, max) {
      const value = String(text || '')
      return value.length <= max ? value : `${value.slice(0, max - 1)}…`
    }

    function errorText(reason) {
      const code = reason && reason.code ? String(reason.code) : ''
      const message = String((reason && reason.message) || reason)
      return code === '' ? message : `${code}：${message}`
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                             */
    /* ------------------------------------------------------------------ */

    const S = {
      page: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        fontSize: 13,
        containerType: 'inline-size',
        containerName: 'exp-ui',
      },
      header: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 12px' },
      titleWrap: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 auto' },
      titleRow: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 19, fontWeight: 600, lineHeight: '26px' },
      countBadge: {
        fontSize: 11,
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: 999,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      sourceBadge: {
        fontSize: 11,
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      },
      sub: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        flexWrap: 'wrap',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 11,
      },
      path: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 520,
      },
      headerRight: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
      search: {
        width: 260,
        padding: '6px 10px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        outline: 'none',
        fontFamily: 'inherit',
      },
      button: {
        padding: '6px 12px',
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      primaryButton: {
        padding: '6px 12px',
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-button-primary-fill)',
        border: '1px solid transparent',
        borderRadius: 8,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      ghostButton: {
        padding: '4px 8px',
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: 6,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      disabledButton: {
        padding: '6px 12px',
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        cursor: 'not-allowed',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      statRow: { display: 'flex', gap: 8, padding: '0 24px 10px', flexWrap: 'wrap' },
      stat: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        minWidth: 0,
        padding: '5px 10px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
      },
      statLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'nowrap' },
      statValue: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: '20px' },
      statUnit: { fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 3 },
      tabs: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 24px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      tab: {
        padding: '7px 10px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: 0,
        borderBottom: '2px solid transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      tabOn: {
        padding: '7px 10px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: 0,
        borderBottom: '2px solid var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: 600,
      },
      banner: {
        margin: '12px 24px 0',
        padding: '8px 12px',
        fontSize: 12,
        lineHeight: 1.6,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      bannerWarn: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
      },
      bannerError: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
      },
      body: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
      main: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0, minHeight: 0 },
      filters: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        padding: '10px 24px 8px',
      },
      chip: {
        padding: '2px 9px',
        fontSize: 11,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 999,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      chipOn: {
        padding: '2px 9px',
        fontSize: 11,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-button-primary-fill)',
        border: '1px solid transparent',
        borderRadius: 999,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      chipCount: { marginLeft: 5, opacity: 0.7, fontVariantNumeric: 'tabular-nums' },
      spacer: { flex: '1 1 auto' },
      select: {
        padding: '3px 6px',
        fontSize: 11,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        fontFamily: 'inherit',
        outline: 'none',
      },
      scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '0 16px 24px 24px' },
      row: {
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        marginBottom: 6,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'inherit',
      },
      rowOn: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1))',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      typePill: {
        flex: '0 0 auto',
        maxWidth: 130,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 10.5,
        lineHeight: '17px',
        padding: '0 7px',
        borderRadius: 5,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent)',
      },
      intent: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: '19px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      gPill: {
        flex: '0 0 auto',
        fontSize: 11,
        lineHeight: '17px',
        padding: '0 7px',
        borderRadius: 5,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      rowAction: {
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '18px',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      meta: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '2px 10px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 11,
      },
      outcome: {
        fontSize: 10.5,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 4,
        whiteSpace: 'nowrap',
      },
      group: {
        marginBottom: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '2px 10px',
        padding: '8px 12px',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      groupAction: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontWeight: 600,
        fontSize: 12,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '1 1 auto',
      },
      badge: {
        fontSize: 10.5,
        lineHeight: '17px',
        padding: '0 6px',
        borderRadius: 4,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      evidence: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'inherit',
      },
      aside: {
        flex: '0 0 380px',
        width: 380,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      asideHead: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '14px 16px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      asideBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 16px 24px' },
      section: { marginBottom: 14 },
      sectionTitle: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.02em',
        marginBottom: 5,
      },
      paragraph: { margin: 0, fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      kv: { display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: '3px 10px', fontSize: 12, lineHeight: 1.6 },
      k: { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      v: { color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
      mono: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        overflowWrap: 'anywhere',
      },
      feedbackRow: { display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' },
      empty: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '56px 24px',
        color: 'var(--dsw-alias-label-secondary)',
        textAlign: 'center',
        fontSize: 12,
        lineHeight: 1.7,
      },
      toast: {
        position: 'absolute',
        left: '50%',
        bottom: 22,
        transform: 'translateX(-50%)',
        padding: '7px 14px',
        fontSize: 12,
        borderRadius: 999,
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 88%, transparent)',
        boxShadow: '0 4px 18px rgba(0, 0, 0, 0.18)',
        pointerEvents: 'none',
        maxWidth: '80%',
        textAlign: 'center',
      },
      tableRow: {
        display: 'grid',
        gridTemplateColumns: '120px 64px minmax(0, 1fr)',
        gap: 10,
        alignItems: 'baseline',
        padding: '7px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
      },
      typeCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '10px 12px',
        marginBottom: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      skillCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 14px',
        marginBottom: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      skillName: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, minWidth: 0, overflowWrap: 'anywhere', transition: 'color .15s ease' },
      skillHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      chevron: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1, flex: '0 0 auto' },
      asideBack: { display: 'none', marginRight: 2 },
      detailNav: { display: 'inline-flex', alignItems: 'center', gap: 2 },
      kbd: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 10,
        lineHeight: '15px',
        color: 'var(--dsw-alias-label-tertiary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 4,
        padding: '0 4px',
      },
      skillDesc: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
      skillBody: {
        margin: '2px 0 0',
        padding: '8px 10px',
        maxHeight: 240,
        overflowY: 'auto',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 11.5,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      chipTag: {
        fontSize: 10.5,
        lineHeight: '17px',
        padding: '0 6px',
        borderRadius: 4,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent)',
        whiteSpace: 'nowrap',
      },
    }

    function toneStyle(tone) {
      const map = {
        ok: ['var(--dsw-alias-state-success-primary)', '12%'],
        bad: ['var(--dsw-alias-state-error-primary)', '12%'],
        warn: ['var(--dsw-alias-state-warn-primary)', '14%'],
        muted: ['var(--dsw-alias-label-secondary)', '10%'],
      }
      const pair = map[tone] || map.muted
      return {
        color: pair[0],
        background: `color-mix(in srgb, ${pair[0]} ${pair[1]}, transparent)`,
      }
    }

    /* ------------------------------------------------------------------ */
    /* Main panel                                                         */
    /* ------------------------------------------------------------------ */

    function ExpUiPanel() {
      const [state, setState] = useState(null)
      const [list, setList] = useState(null)
      const [usage, setUsage] = useState(null)
      const [skills, setSkills] = useState(null)
      const [expandedSkill, setExpandedSkill] = useState('')
      const [tab, setTab] = useState('experiences')
      const [queryInput, setQueryInput] = useState('')
      const [query, setQuery] = useState('')
      const [typeFilter, setTypeFilter] = useState('')
      const [outcomeFilter, setOutcomeFilter] = useState('')
      const [sort, setSort] = useState('recent')
      const [selectedId, setSelectedId] = useState('')
      const [cursorId, setCursorId] = useState('')
      const [detail, setDetail] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const [toast, setToast] = useState('')
      const toastTimer = useRef(null)
      const requestSeq = useRef(0)
      const searchRef = useRef(null)

      const notify = useCallback((text) => {
        setToast(text)
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 3200)
      }, [])

      useEffect(() => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      }, [])

      const readOnly = Boolean(state && state.source && state.source.readOnly)

      const loadState = useCallback(async () => {
        try {
          const data = await request('state')
          setState(data)
          return data
        } catch (reason) {
          setError(errorText(reason))
          return null
        }
      }, [])

      const loadList = useCallback(async () => {
        const seq = requestSeq.current + 1
        requestSeq.current = seq
        setLoading(true)
        try {
          const params = new URLSearchParams()
          if (query !== '') params.set('query', query)
          if (typeFilter !== '') params.set('type', typeFilter)
          if (outcomeFilter !== '') params.set('outcome', outcomeFilter)
          params.set('sort', sort)
          params.set('limit', '100')
          const data = await request(`experiences?${params.toString()}`)
          if (requestSeq.current !== seq) return
          setList(data)
          setError('')
        } catch (reason) {
          if (requestSeq.current !== seq) return
          setError(errorText(reason))
        } finally {
          if (requestSeq.current === seq) setLoading(false)
        }
      }, [query, typeFilter, outcomeFilter, sort])

      const loadUsage = useCallback(async () => {
        try {
          const data = await request('usage?limit=120')
          setUsage(data)
        } catch (reason) {
          setError(errorText(reason))
        }
      }, [])

      const loadSkills = useCallback(async () => {
        try {
          const data = await request('skills')
          setSkills(data)
        } catch (reason) {
          setError(errorText(reason))
        }
      }, [])

      useEffect(() => {
        loadState()
        loadList()
      }, [loadState, loadList])

      useEffect(() => {
        if (tab === 'usage' && usage === null) loadUsage()
      }, [tab, usage, loadUsage])

      useEffect(() => {
        if (tab === 'skills' && skills === null) loadSkills()
      }, [tab, skills, loadSkills])

      const loadDetail = useCallback(async (id) => {
        if (!id) return
        try {
          const data = await request(`experience?id=${encodeURIComponent(id)}`)
          setDetail(data)
          setError('')
        } catch (reason) {
          setError(errorText(reason))
          setDetail(null)
          setSelectedId('')
        }
      }, [])

      const closeDetail = useCallback(() => {
        setSelectedId('')
        setDetail(null)
      }, [])

      const select = useCallback((id) => {
        // 再点一次当前行 = 收起详情，别让用户只能靠 Esc。
        if (id === '' || id === selectedId) {
          closeDetail()
          return
        }
        setCursorId(id)
        setSelectedId(id)
        setDetail(null)
        loadDetail(id)
      }, [selectedId, closeDetail, loadDetail])

      const switchTab = useCallback((id) => {
        setTab(id)
        // 详情只属于「经验」页；切走就收起，避免下一页还挂着旧内容。
        if (id !== 'experiences') closeDetail()
      }, [closeDetail])

      // 换题型 / 换检索 / 换结果过滤：右侧那条可能已经不在列表里，收起详情。
      useEffect(() => {
        closeDetail()
      }, [query, typeFilter, outcomeFilter, closeDetail])

      const submitSearch = useCallback(() => {
        setQuery(queryInput.trim())
      }, [queryInput])

      const clearSearch = useCallback(() => {
        setQueryInput('')
        setQuery('')
      }, [])

      const refresh = useCallback(() => {
        loadState()
        loadList()
        if (tab === 'usage') loadUsage()
        if (tab === 'skills') loadSkills()
        if (selectedId !== '') loadDetail(selectedId)
      }, [loadState, loadList, loadUsage, loadSkills, loadDetail, tab, selectedId])

      const sendFeedback = useCallback(async (row, result) => {
        if (readOnly) {
          notify('exp-ui 处于只读模式：接入真实经验库之前不改数据。')
          return
        }
        try {
          const receipt = await request('feedback', { method: 'POST', body: { id: row.id, result } })
          const label = result === 'helped' ? '有帮助' : result === 'hurt' ? '没帮上' : '中性'
          notify(`已记「${label}」：G ${fmtNumber(receipt.G_before)} → ${fmtNumber(receipt.G_after)}`)
          await loadState()
          await loadList()
          if (selectedId === row.id) await loadDetail(row.id)
          if (tab === 'usage') await loadUsage()
        } catch (reason) {
          notify(`反馈没成：${errorText(reason)}`)
        }
      }, [readOnly, notify, loadState, loadList, loadDetail, selectedId, tab, loadUsage])

      const copyId = useCallback((id) => {
        try {
          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(id).then(() => notify(`已复制 ${id}`)).catch(() => notify('复制失败'))
            return
          }
        } catch {
          // 没有剪贴板权限就只把 id 显示出来。
        }
        notify(`id：${id}`)
      }, [notify])

      const typesById = useMemo(() => {
        const map = new Map()
        for (const type of (state && Array.isArray(state.types) ? state.types : [])) map.set(type.id, type)
        return map
      }, [state])

      const rows = list !== null && Array.isArray(list.rows) ? list.rows : []
      const visibleTotal = state && state.totals ? state.totals.visible : rows.length
      const selectedRow = useMemo(() => {
        if (detail !== null) return detail.row
        for (const row of rows) if (row.id === selectedId) return row
        return null
      }, [detail, rows, selectedId])

      // 键盘：/ 聚焦检索；↑↓ 移动游标；Enter 打开；Esc 收起详情。
      useEffect(() => {
        const onKey = (event) => {
          const target = event && event.target
          const tag = target && target.tagName ? String(target.tagName).toUpperCase() : ''
          const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target && target.isContentEditable)
          if (event.key === '/' && !typing) {
            event.preventDefault()
            if (searchRef.current !== null) searchRef.current.focus()
            return
          }
          if (event.key === 'Escape') {
            if (selectedId !== '') closeDetail()
            return
          }
          if (typing || tab !== 'experiences' || rows.length === 0) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const current = rows.findIndex((row) => row.id === (cursorId || selectedId))
            const fallback = event.key === 'ArrowDown' ? 0 : rows.length - 1
            const index = current < 0
              ? fallback
              : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
            const next = rows[index]
            if (next !== undefined) setCursorId(next.id)
            return
          }
          if (event.key === 'Enter' && cursorId !== '') {
            event.preventDefault()
            select(cursorId)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [rows, cursorId, selectedId, tab, closeDetail, select])

      const outcomeOptions = ['success', 'partial', 'failed', 'corrected', 'aborted', 'unknown']

      const kpis = [
        { label: '可见经验', value: String(visibleTotal), unit: '条' },
        { label: '固化技能', value: state ? String(state.totals.skills) : '—', unit: '个' },
        { label: '今日调用', value: state && state.usage ? String(state.usage.today) : '—', unit: '次' },
        { label: '库大小', value: state ? fmtBytes(state.bytes) : '—', unit: '' },
      ]

      function renderBanners() {
        const nodes = []
        if (error !== '') {
          nodes.push(h('div', { key: 'err', style: { ...S.banner, ...S.bannerError } },
            `接口出错：${error}`,
            h('button', { type: 'button', style: { ...S.ghostButton, marginLeft: 8 }, onClick: refresh }, '重试')))
        }
        if (state && state.notice) {
          nodes.push(h('div', { key: 'notice', style: S.banner }, state.notice))
        }
        if (list !== null && list.warning) {
          nodes.push(h('div', { key: 'warn', style: { ...S.banner, ...S.bannerWarn } }, list.warning))
        }
        if (list !== null && (list.mode === 'advantage' || list.mode === 'evidence') && list.note) {
          nodes.push(h('div', { key: 'note', style: S.banner },
            h('span', { style: { marginRight: 8 } }, list.mode === 'advantage' ? '按优势排序' : '按证据排序'),
            list.note))
        }
        return nodes
      }

      function renderRow(row) {
        const outcome = outcomeOf(row.outcome)
        const on = row.id === selectedId
        const cursor = row.id === cursorId
        return h('button', {
          key: row.id,
          type: 'button',
          className: 'exp-ui-row',
          'aria-pressed': on,
          style: on
            ? { ...S.row, ...S.rowOn }
            : cursor
              ? { ...S.row, borderColor: 'var(--dsw-alias-label-secondary)' }
              : S.row,
          onClick: () => select(row.id),
        },
        h('div', { style: S.rowHead },
          h('span', { style: S.typePill, title: row.typeName }, row.typeName),
          h('span', { style: S.intent, title: row.intent }, row.intent || '(无意图)'),
          h('span', { style: S.gPill, title: '回报 G（含用后反馈）' }, `G ${fmtNumber(row.G)}`),
          h('span', { style: S.chevron }, on ? '▾' : '›')),
        h('div', { style: S.rowAction, title: row.action }, row.action || '(无做法)'),
        h('div', { style: S.meta },
          h('span', { style: { ...S.outcome, ...toneStyle(outcome.tone) } }, outcome.label),
          h('span', null, `用过 ${row.hits} 次`),
          row.feedback
            ? h('span', null, `反馈 有帮助${row.feedback.helped} / 没帮上${row.feedback.hurt} / 中性${row.feedback.neutral}`)
            : h('span', null, '反馈 —'),
          h('span', null, `最近 ${fmtShortTime(row.lastSeenAt)}`),
          row.stepIndex !== null ? h('span', null, `步骤 ${row.stepIndex}${row.stepTotal ? `/${row.stepTotal}` : ''}`) : null,
          row.lifecycle && row.lifecycle.retiredAt ? h('span', { style: toneStyle('warn') }, '已退休') : null,
          row.lifecycle && row.lifecycle.supersededBy ? h('span', { style: toneStyle('muted') }, '已被取代') : null))
      }

      function renderRecall() {
        if (rows.length === 0) {
          return h('div', { style: S.empty },
            h('div', null, '没有相近的历史经验'),
            h('div', null, '换成更具体的意图再试；真实经验库里也可以先记一条。'))
        }
        return rows.map((candidate, index) => h('div', { key: `${candidate.action}::${index}`, style: S.group },
          h('div', { style: S.groupHead },
            h('span', { style: S.badge }, `#${index + 1}`),
            h('span', { style: S.groupAction, title: candidate.action }, candidate.action || '(无做法)'),
            h('span', { style: S.badge }, `相似 ${fmtNumber(candidate.meanSimilarity)}`),
            h('span', { style: S.badge }, `支持 ${candidate.support}`),
            h('span', { style: S.badge }, `Â ${fmtNumber(candidate.advantage, 3)}`),
            h('span', { style: S.badge }, `置信 ${fmtNumber(candidate.confidence)}`),
            h('span', { style: S.badge }, `排名 ${fmtNumber(candidate.rankScore, 3)}`)),
        (candidate.evidence || []).map((evidence) => {
          const outcome = outcomeOf(evidence.outcome)
          return h('button', {
            key: evidence.id,
            type: 'button',
            className: 'exp-ui-row',
            style: evidence.id === selectedId
              ? { ...S.evidence, ...S.rowOn }
              : evidence.id === cursorId
                ? { ...S.evidence, borderColor: 'var(--dsw-alias-label-secondary)' }
                : S.evidence,
            onClick: () => select(evidence.id),
          },
          h('div', { style: S.rowHead },
            h('span', { style: { ...S.outcome, ...toneStyle(outcome.tone), flex: '0 0 auto' } }, outcome.label),
            h('span', { style: S.intent, title: evidence.intent }, evidence.intent || '(无意图)'),
            h('span', { style: S.gPill }, `G ${fmtNumber(evidence.G)}`)),
          h('div', { style: S.rowAction, title: evidence.action }, evidence.action),
          evidence.note ? h('div', { style: { ...S.meta, overflow: 'hidden' } }, truncate(evidence.note, 160)) : null,
          h('div', { style: S.meta },
            h('span', null, evidence.typeName || '未分类'),
            h('span', null, `相似 ${fmtNumber(evidence.similarity, 3)}`),
            evidence.lifecycle && evidence.lifecycle.retiredAt ? h('span', null, '已退休') : null,
            evidence.feedback
              ? h('span', null, `反馈 ${evidence.feedback.helped}/${evidence.feedback.hurt}/${evidence.feedback.neutral}`)
              : null))
        })))
      }

      function renderFilters() {
        const counts = list && list.counts ? list.counts : {}
        const typeList = state && Array.isArray(state.types) ? state.types : []
        return h('div', { style: S.filters },
          h('button', {
            type: 'button',
            style: typeFilter === '' ? S.chipOn : S.chip,
            onClick: () => setTypeFilter(''),
          }, '全部', h('span', { style: S.chipCount }, String(list && list.mode === 'list' ? list.total : visibleTotal))),
          typeList.map((type) => h('button', {
            key: type.id,
            type: 'button',
            title: type.description || '',
            style: typeFilter === type.id ? S.chipOn : S.chip,
            onClick: () => setTypeFilter(typeFilter === type.id ? '' : type.id),
          }, type.name, h('span', { style: S.chipCount }, String(counts[type.id] || type.count || 0)))),
          h('span', { style: S.spacer }),
          h('select', {
            style: S.select,
            value: outcomeFilter,
            onChange: (event) => setOutcomeFilter(event.target.value),
            title: '按结果过滤',
          },
          h('option', { value: '' }, '全部结果'),
          outcomeOptions.map((value) => h('option', { key: value, value }, outcomeOf(value).label))),
          h('select', {
            style: S.select,
            value: sort,
            onChange: (event) => setSort(event.target.value),
            title: '排序',
          },
          h('option', { value: 'recent' }, '最近用过'),
          h('option', { value: 'g' }, '回报 G'),
          h('option', { value: 'hits' }, '用得最多'),
          h('option', { value: 'type' }, '按类型')),
          h('span', { style: { ...S.meta, marginLeft: 4 } }, `${rows.length} 条`),
          (query !== '' || typeFilter !== '' || outcomeFilter !== '')
            ? h('button', {
              type: 'button',
              style: { ...S.ghostButton, marginLeft: 2 },
              onClick: () => {
                setQueryInput('')
                setQuery('')
                setTypeFilter('')
                setOutcomeFilter('')
                setCursorId('')
              },
            }, '清除筛选')
            : null)
      }

      function renderExperiences() {
        const recalling = list !== null && (list.mode === 'advantage' || list.mode === 'evidence')
        return h('div', { style: S.main },
          renderFilters(),
          h('div', { style: S.scroll },
            rows.length === 0 && loading ? h('div', { style: S.empty }, '读取中…') : null,
            rows.length === 0 && !loading
              ? (recalling
                ? renderRecall()
                : h('div', { style: S.empty },
                  h('div', null, state && state.exists === false ? '还没有读到经验数据' : '这个筛选下没有经验'),
                  h('div', null, state && state.dataDir ? `数据位置：${state.dataDir}` : ''),
                  h('button', {
                    type: 'button',
                    style: S.button,
                    onClick: () => {
                      setQueryInput('')
                      setQuery('')
                      setTypeFilter('')
                      setOutcomeFilter('')
                      setCursorId('')
                    },
                  }, '清除筛选')))
              : null,
            rows.length > 0 && recalling ? renderRecall() : null,
            rows.length > 0 && !recalling ? rows.map(renderRow) : null))
      }

      function renderSkillCard(skill) {
        const status = skillStatusOf(skill.status)
        const expanded = expandedSkill === skill.id
        const percent = Math.round((Number(skill.ratio) || 0) * 100)
        const toggle = () => setExpandedSkill(expanded ? '' : skill.id)
        return h('div', { key: skill.id, className: 'exp-ui-skill', style: S.skillCard },
          h('div', {
            className: 'exp-ui-skill-head',
            style: S.skillHead,
            role: 'button',
            tabIndex: 0,
            'aria-expanded': expanded,
            onClick: toggle,
            onKeyDown: (event) => {
              if (event && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
                toggle()
              }
            },
          },
          h('span', { className: 'exp-ui-skill-title', style: S.skillName }, skill.name),
          h('span', { style: { ...S.badge, ...toneStyle(status.tone) } }, status.label),
          h('span', { style: S.chipTag }, skill.typeName || '未分类'),
          h('span', { style: S.spacer }),
          h('span', { style: S.chevron }, expanded ? '▾' : '▸')),
          h('div', { style: S.skillDesc }, skill.description || '（无描述）'),
          expanded ? h('pre', { style: S.skillBody }, skill.body || '（无正文）') : null,
          h('div', { style: S.meta },
            h('span', null, `用过 ${skill.uses} 次`),
            h('span', null, `有帮助 ${skill.helped} / 没帮上 ${skill.hurt}`),
            h('span', null, `比例 ${percent}%`),
            h('span', null, `修订 ${skill.revisions}`),
            h('span', null, `障碍 ${skill.obstacleCount}${skill.openObstacleCount > 0 ? `（未解 ${skill.openObstacleCount}）` : ''}`),
            h('span', null, `来源 ${skill.derivedFrom.length} 条经验`),
            skill.lastUsedAt ? h('span', null, `最近 ${fmtShortTime(skill.lastUsedAt)}`) : h('span', null, '还没用过'),
            skill.pendingCommit ? h('span', { style: toneStyle('warn') }, '待提交') : null,
            skill.context.length > 0 ? h('span', null, `情境 ${skill.context.join(' / ')}`) : null,
            skill.triggers.length > 0 ? h('span', null, `触发 ${skill.triggers.join(' / ')}`) : null),
          h('div', { style: S.mono }, skill.path || ''))
      }

      function renderSkills() {
        const data = skills && Array.isArray(skills.skills) ? skills.skills : null
        if (data === null) return h('div', { style: S.main }, h('div', { style: S.empty }, '读取中…'))
        const summary = skills.summary || { total: data.length, solid: 0, trial: 0, risky: 0, new: 0, blocked: 0 }
        const header = h('div', { style: { ...S.filters, color: 'var(--dsw-alias-label-tertiary)' } },
          h('span', null, `${data.length} 个技能`),
          summary.solid > 0 ? h('span', { style: { ...S.badge, ...toneStyle('ok') } }, `已固化 ${summary.solid}`) : null,
          summary.trial > 0 ? h('span', { style: { ...S.badge, ...toneStyle('warn') } }, `试用中 ${summary.trial}`) : null,
          summary.risky > 0 ? h('span', { style: { ...S.badge, ...toneStyle('bad') } }, `不稳定 ${summary.risky}`) : null,
          summary.blocked > 0 ? h('span', { style: { ...S.badge, ...toneStyle('bad') } }, `有障碍 ${summary.blocked}`) : null,
          h('span', { style: S.spacer }),
          h('span', null, '同族经验 ≥3 且 ≥2 正 1 负 → exp_consolidate 写入 <dataDir>/skills/'))
        if (data.length === 0) {
          return h('div', { style: S.main }, header, h('div', { style: S.empty },
            h('div', null, '还没有固化技能'),
            h('div', null, '沉淀条件：同一类型 ≥3 条经验，其中 ≥2 条正回报且有 1 条负回报；由 exp_consolidate 写成 .exp/skills/<slug>/（SKILL.md + skill.json）。'),
            h('div', null, state && state.source && state.source.mode === 'mock'
              ? '示例数据里本应有 5 个技能，看到这条说明没读到。'
              : '真实库里还没有沉淀过技能；示例数据模式下能先看界面。')))
        }
        return h('div', { style: S.main }, header, h('div', { style: S.scroll }, data.map(renderSkillCard)))
      }

      function renderTypes() {
        const types = state && Array.isArray(state.types) ? state.types : []
        return h('div', { style: S.main },
          h('div', { style: S.scroll },
            types.length === 0
              ? h('div', { style: S.empty }, '还没有类型')
              : types.map((type) => h('div', { key: type.id, style: S.typeCard },
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 13, fontWeight: 600 } }, type.name),
                  h('span', { style: S.badge }, `${type.count} 条`),
                  type.system ? h('span', { style: S.badge }, '系统') : null,
                  h('span', { style: S.spacer }),
                  h('button', {
                    type: 'button',
                    style: S.ghostButton,
                    onClick: () => {
                      setTab('experiences')
                      setQuery('')
                      setQueryInput('')
                      setTypeFilter(type.id)
                    },
                  }, '看这些经验')),
                h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 } },
                  type.description || '（描述待补：类型描述决定模型「什么该写进来、什么时候该召回」）')))))
      }

      function renderUsage() {
        const rowsUsage = usage && Array.isArray(usage.rows) ? usage.rows : null
        if (rowsUsage === null) return h('div', { style: S.main }, h('div', { style: S.empty }, '读取中…'))
        if (rowsUsage.length === 0) {
          return h('div', { style: S.main }, h('div', { style: S.empty },
            h('div', null, '还没有调用记录'),
            h('div', null, '真实经验库每调用一次工具记一行；这里是示例数据，接入后会换成真实日志。')))
        }
        return h('div', { style: S.main },
          h('div', { style: { ...S.filters, color: 'var(--dsw-alias-label-tertiary)' } },
            h('span', null, `最近 ${rowsUsage.length} 条（新→旧）`),
            h('span', { style: S.spacer }),
            h('span', null, state && state.source ? `${state.source.label} · ${state.source.readOnly ? '只读' : '可反馈'}` : '')),
          h('div', { style: S.scroll },
            h('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' } },
              rowsUsage.map((row, index) => {
                const targetId = Array.isArray(row.ids) && row.ids.length > 0 ? row.ids[0] : ''
                const openTarget = targetId === ''
                  ? undefined
                  : () => {
                    setTab('experiences')
                    setCursorId(targetId)
                    setSelectedId(targetId)
                    setDetail(null)
                    loadDetail(targetId)
                  }
                return h('div', {
                  key: `${row.at}-${index}`,
                  className: targetId === '' ? '' : 'exp-ui-usage-link',
                  title: targetId === '' ? '' : `打开经验 ${targetId}`,
                  style: index === rowsUsage.length - 1 ? { ...S.tableRow, borderBottom: '0' } : S.tableRow,
                  onClick: openTarget,
                },
                h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' } }, fmtShortTime(row.at)),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, TOOLS[row.tool] || row.tool || '—'),
                h('span', { style: { minWidth: 0, color: 'var(--dsw-alias-label-secondary)' } },
                  row.ok === false
                    ? h('span', { style: { ...toneStyle('bad'), padding: '0 5px', borderRadius: 4, marginRight: 6 } }, '失败')
                    : null,
                  row.feedback ? h('span', { style: { marginRight: 6 } }, `反馈 ${row.feedback}`) : null,
                  truncate(row.intent || row.action || row.error || '', 120),
                  targetId !== '' ? h('span', { style: { ...S.chevron, marginLeft: 6 } }, '↗') : null))
              }))))
      }

      function renderAside() {
        if (selectedRow === null && detail === null) {
          return h('div', { className: 'exp-ui-aside', style: S.aside },
            h('div', { style: S.empty },
              h('div', null, '选一条经验看详情'),
              h('div', null, readOnly ? '当前是只读模式。' : '可以记用后反馈（有帮助 / 没帮上 / 中性）。')))
        }
        const row = selectedRow || {
          id: '',
          intent: '',
          action: '',
          typeName: '',
          outcome: 'unknown',
          G: 0,
          note: '',
          feedback: null,
          lifecycle: {},
        }
        const outcome = outcomeOf(row.outcome)
        const detailHistory = detail && Array.isArray(detail.history) ? detail.history : []
        const detailFeedback = detail && Array.isArray(detail.feedbackLog) ? detail.feedbackLog : []
        const typeMeta = typesById.get(row.typeId) || null
        const feedbackDisabled = readOnly
        const index = rows.findIndex((item) => item.id === row.id)
        const previous = index > 0 ? rows[index - 1] : null
        const following = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null
        return h('aside', { className: 'exp-ui-aside', style: S.aside },
          h('div', { style: S.asideHead },
            h('button', {
              type: 'button',
              className: 'exp-ui-aside-back',
              style: { ...S.ghostButton, marginRight: 2 },
              title: '返回列表（Esc）',
              onClick: closeDetail,
            }, '← 返回'),
            h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
              h('div', { style: S.sectionTitle }, '经验'),
              h('div', { style: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, overflowWrap: 'anywhere' } }, row.intent || '(无意图)')),
            h('div', { style: S.detailNav },
              h('button', { type: 'button', style: S.ghostButton, disabled: previous === null, title: '上一条（↑）', onClick: () => previous !== null && select(previous.id) }, '↑'),
              h('button', { type: 'button', style: S.ghostButton, disabled: following === null, title: '下一条（↓）', onClick: () => following !== null && select(following.id) }, '↓')),
            h('button', {
              type: 'button',
              title: '关闭（Esc）',
              style: S.ghostButton,
              onClick: closeDetail,
            }, '✕')),
          h('div', { style: S.asideBody },
            h('div', { style: S.section },
              h('div', { style: S.sectionTitle }, '做法'),
              h('p', { style: { ...S.paragraph, ...S.mono } }, row.action || '—')),
            h('div', { style: S.section },
              h('div', { style: S.sectionTitle }, '结果与回报'),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
                h('span', { style: { ...S.outcome, ...toneStyle(outcome.tone), padding: '1px 8px' } }, outcome.label),
                h('span', { style: S.gPill }, `G ${fmtNumber(row.G)}`),
                h('span', { style: S.badge }, row.GSource === 'feedback' ? '含反馈修正' : '按结果')),
              h('div', { style: S.kv },
                h('span', { style: S.k }, '反馈'), h('span', { style: S.v }, row.feedback
                  ? `有帮助 ${row.feedback.helped} · 没帮上 ${row.feedback.hurt} · 中性 ${row.feedback.neutral}（窗口 ${row.feedback.window}）`
                  : '暂无'),
                h('span', { style: S.k }, '类型'), h('span', { style: S.v }, `${row.typeName}${typeMeta && typeMeta.description ? `：${truncate(typeMeta.description, 80)}` : ''}`),
                h('span', { style: S.k }, '来源'), h('span', { style: S.v }, row.origin),
                h('span', { style: S.k }, '用过'), h('span', { style: S.v }, `${row.hits} 次`),
                h('span', { style: S.k }, '首次'), h('span', { style: S.v }, fmtTime(row.createdAt)),
                h('span', { style: S.k }, '最近'), h('span', { style: S.v }, fmtTime(row.lastSeenAt)),
                row.taskId ? h('span', { style: S.k }, '任务') : null,
                row.taskId ? h('span', { style: S.v }, `${row.taskId}${row.stepIndex !== null ? ` · 步骤 ${row.stepIndex}${row.stepTotal ? `/${row.stepTotal}` : ''}` : ''}`) : null,
                row.lifecycle && row.lifecycle.retiredAt ? h('span', { style: S.k }, '退休') : null,
                row.lifecycle && row.lifecycle.retiredAt ? h('span', { style: S.v }, `${row.lifecycle.retiredReason || 'retired'} · ${fmtTime(row.lifecycle.retiredAt)}`) : null,
                row.lifecycle && row.lifecycle.supersededBy ? h('span', { style: S.k }, '取代') : null,
                row.lifecycle && row.lifecycle.supersededBy ? h('span', { style: S.v }, `已被 ${row.lifecycle.supersededBy} 取代`) : null)),
            h('div', { style: S.section },
              h('div', { style: S.sectionTitle }, '备注'),
              h('p', { style: S.paragraph }, row.note || '（无）')),
            h('div', { style: S.section },
              h('div', { style: S.sectionTitle }, '用后反馈'),
              h('div', { style: S.feedbackRow },
                h('button', { type: 'button', style: feedbackDisabled ? S.disabledButton : S.button, disabled: feedbackDisabled, onClick: () => sendFeedback(row, 'helped') }, '有帮助'),
                h('button', { type: 'button', style: feedbackDisabled ? S.disabledButton : S.button, disabled: feedbackDisabled, onClick: () => sendFeedback(row, 'hurt') }, '没帮上'),
                h('button', { type: 'button', style: feedbackDisabled ? S.disabledButton : S.button, disabled: feedbackDisabled, onClick: () => sendFeedback(row, 'neutral') }, '中性')),
              h('div', { style: { ...S.meta, fontSize: 11 } }, feedbackDisabled
                ? '只读模式：接入真实经验库之前不改数据。'
                : '改的是这条的 G（EMA 0.35），不动次数与结果；示例数据只改内存，不落盘。')),
            detailHistory.length > 0
              ? h('div', { style: S.section },
                h('div', { style: S.sectionTitle }, '生命周期'),
                h('div', { style: S.kv }, detailHistory.map((event, index) => [
                  h('span', { key: `k${index}`, style: S.k }, String(event.type || '—')),
                  h('span', { key: `v${index}`, style: S.v }, `${fmtTime(event.at)}${event.reason ? ` · ${event.reason}` : ''}`),
                ])))
              : null,
            detailFeedback.length > 0
              ? h('div', { style: S.section },
                h('div', { style: S.sectionTitle }, '反馈记录'),
                h('div', { style: S.kv }, detailFeedback.map((event, index) => [
                  h('span', { key: `k${index}`, style: S.k }, String(event.result || '—')),
                  h('span', { key: `v${index}`, style: S.v }, fmtTime(event.at)),
                ])))
              : null,
            h('div', { style: S.section },
              h('div', { style: { ...S.sectionTitle, display: 'flex', alignItems: 'center', gap: 6 } },
                'id',
                h('button', {
                  type: 'button',
                  style: { ...S.ghostButton, padding: '0 4px' },
                  title: '复制 id',
                  onClick: () => copyId(row.id),
                }, '复制')),
              h('div', { style: S.mono }, row.id || '—'))))
      }

      const tabs = [
        { id: 'experiences', label: '经验', count: visibleTotal },
        { id: 'skills', label: '固化技能', count: state ? state.totals.skills : null },
        { id: 'types', label: '类型', count: state ? state.totals.types : null },
        { id: 'usage', label: '使用记录', count: state && state.usage ? state.usage.total : null },
      ]
      const sourceLabel = state && state.source ? state.source.label : ''
      const sourceTone = state && state.source
        ? (state.source.mode === 'mock' ? 'warn' : 'ok')
        : 'muted'

      return h('div', { className: 'exp-ui-page', style: { ...S.page, position: 'relative' } },
        h('div', { style: S.header },
          h('div', { style: S.titleWrap },
            h('div', { style: S.titleRow },
              h('h1', { style: S.title }, TITLE),
              sourceLabel === ''
                ? null
                : h('span', { style: { ...S.sourceBadge, ...toneStyle(sourceTone) } }, sourceLabel),
              state ? h('span', { style: S.countBadge }, `${visibleTotal} 条经验`) : null,
              state ? h('span', { style: S.countBadge }, `v${state.version}`) : null,
              state && state.source && state.source.readOnly ? h('span', { style: S.countBadge }, '只读') : null),
            h('div', { style: S.sub },
              h('span', { style: S.path, title: state ? state.dataDir : '' }, state ? state.dataDir : '—'),
              state && state.updatedAt ? h('span', null, `· 更新于 ${fmtShortTime(state.updatedAt)}`) : null,
              state && state.usage && state.usage.lastAt ? h('span', null, `· 最近调用 ${fmtShortTime(state.usage.lastAt)}`) : null)),
          h('div', { style: S.headerRight },
            h('input', {
              ref: searchRef,
              style: S.search,
              placeholder: '按意图检索（/ 聚焦）：比如「把 PPT 导出成 PDF」',
              value: queryInput,
              onChange: (event) => setQueryInput(event.target.value),
              onKeyDown: (event) => {
                if (event && event.key === 'Enter') submitSearch()
              },
            }),
            h('button', { type: 'button', style: S.primaryButton, onClick: submitSearch }, '检索'),
            query !== '' ? h('button', { type: 'button', style: S.button, onClick: clearSearch }, '清除') : null,
            h('button', { type: 'button', style: S.button, title: '重新读取', onClick: refresh }, '刷新'),
            h('span', { style: S.kbd, title: '按 / 聚焦检索框' }, '/'))),
        h('div', { style: S.statRow },
          kpis.map((kpi) => h('div', { key: kpi.label, style: S.stat },
            h('span', { style: S.statLabel }, kpi.label),
            h('span', { style: S.statValue }, kpi.value, h('span', { style: S.statUnit }, kpi.unit))))),
        h('div', { style: S.tabs },
          tabs.map((item) => h('button', {
            key: item.id,
            type: 'button',
            style: tab === item.id ? S.tabOn : S.tab,
            onClick: () => switchTab(item.id),
          }, item.label, item.count === null ? null : h('span', { style: S.chipCount }, String(item.count))),
          h('span', { style: S.spacer }),
          query !== '' ? h('span', { style: { ...S.meta, paddingBottom: 6 } }, `检索：${query}`) : null)),
        renderBanners(),
        h('div', { style: S.body },
          tab === 'experiences'
            ? renderExperiences()
            : tab === 'skills'
              ? renderSkills()
              : tab === 'types'
                ? renderTypes()
                : renderUsage(),
          tab === 'experiences' && selectedId !== '' ? renderAside() : null),
        toast === '' ? null : h('div', { style: S.toast }, toast))
    }

    /* ------------------------------------------------------------------ */
    /* Plugin page card                                                   */
    /* ------------------------------------------------------------------ */

    function SettingsCard(props) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(() => {
        request('state')
          .then((value) => {
            setData(value)
            setError('')
          })
          .catch((reason) => setError(errorText(reason)))
      }, [])
      useEffect(() => {
        load()
      }, [load])
      const open = () => {
        try {
          if (props && typeof props.openPanel === 'function') props.openPanel()
        } catch {
          // 打开失败不影响卡片。
        }
      }
      return h('div', { style: { padding: '4px 0 0' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, TITLE),
          data ? h('span', { style: S.badge }, data.source.label) : null,
          data ? h('span', { style: S.badge }, `${data.totals.visible} 条经验`) : null,
          data ? h('span', { style: S.badge }, `${data.totals.skills} 个技能`) : null,
          data ? h('span', { style: S.badge }, `${data.totals.types} 个类型`) : null,
          data ? h('span', { style: S.badge }, fmtBytes(data.bytes)) : null,
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.button, onClick: open }, '打开面板'),
          h('button', { type: 'button', style: S.ghostButton, onClick: load }, '刷新')),
        h('div', { style: S.mono, marginBottom: 6 }, data ? data.dataDir || '（示例数据）' : '读取中…'),
        error !== '' ? h('div', { style: { ...S.bannerError, padding: '6px 10px', borderRadius: 8, fontSize: 12 } }, `读取失败：${error}`) : null,
        h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5, lineHeight: 1.6 } },
          data && data.source.mode === 'mock'
            ? '示例数据：反馈只改内存，不写入真实经验库；真实数据接入后换成 live 数据源。'
            : '真实数据（只读）：界面先跑通，写入等经验库引擎接入后再打开。'))
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                             */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ensureStyles()
        const disposers = []

        /**
         * 侧栏那一格的内容：只有图标，没有按钮。
         * 宿主把这段放进 `.panelGlyph`（inline-flex 居中的 span），外面是它自己的行按钮。
         * @param {{size?: number, active?: boolean}} props - 宿主传入的尺寸与选中态。
         */
        function PanelGlyph(props) {
          const size = props && Number(props.size) > 0 ? Number(props.size) : 16
          if (primitives !== null && typeof primitives.IconChecklistOutlineRegular === 'function') {
            return h(primitives.IconChecklistOutlineRegular, { size })
          }
          const active = Boolean(props && props.active)
          return h('svg', {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 1.3 : 1.1,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { display: 'block' },
          },
          h('rect', { x: 1.75, y: 2.5, width: 12.5, height: 11, rx: 2 }),
          h('path', { d: 'M4.4 6.1 L5.7 7.4 L8.1 4.9' }),
          h('path', { d: 'M9.4 6.2 H12.1' }),
          h('path', { d: 'M4.4 9.6 L5.7 10.9 L8.1 8.4' }),
          h('path', { d: 'M9.4 9.7 H12.1' }))
        }

        function BundleCard() {
          return h(SettingsCard, { openPanel: () => ctx.layout.selectPanel(PANEL_ID) })
        }

        try {
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 45,
            label: () => TITLE,
          }, PanelGlyph)))
        } catch (error) {
          console.error('[exp-ui] panellist registration failed', error)
        }

        try {
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, ExpUiPanel)))
        } catch (error) {
          console.error('[exp-ui] main panel registration failed', error)
        }

        try {
          disposers.push(ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: PACKAGE_NAME,
          }, BundleCard)))
        } catch (error) {
          console.error('[exp-ui] bundle card registration failed', error)
        }

        ctx.effect(() => () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch (error) {
              console.error('[exp-ui] dispose failed', error)
            }
          }
        })
      },
    }
  },
})
