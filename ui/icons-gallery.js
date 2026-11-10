/**
 * 图标候选预览页（只给设计挑选用，不参与运行时数据）。
 * 路由：GET /exp-ui/api/icons
 *
 * 每个候选给三种尺寸：64（安装/插件页）、24（面板头）、16（侧栏那格）。
 */

const CANDIDATES = [
  {
    key: 'A',
    name: '双侧记忆弧（现款）',
    note: '左右各一条弧包住中心节点，像记忆痕迹汇到核心；最好认，也最稳。',
    c1: '#2dd4bf',
    c2: '#0f766e',
  },
  {
    key: 'B',
    name: '记忆螺旋',
    note: '从外向内收的螺旋 + 中心点，强调「痕迹」与「沉淀」。',
    c1: '#818cf8',
    c2: '#4338ca',
  },
  {
    key: 'C',
    name: '三节点网络',
    note: '三个节点与连线，直接对应经验/类型/技能的关系图。',
    c1: '#c084fc',
    c2: '#6d28d9',
  },
  {
    key: 'D',
    name: '层叠卡片 + 火花',
    note: '三张叠起来的卡片 + 右上火花，强调「积累」与「技能沉淀」。',
    c1: '#fbbf24',
    c2: '#b45309',
  },
  {
    key: 'E',
    name: '记忆涟漪',
    note: '中心点向外两圈弧，像记忆荡开的波纹，最轻。',
    c1: '#22d3ee',
    c2: '#0e7490',
  },
  {
    key: 'F',
    name: '年轮',
    note: '三段断开的同心弧，像年轮，暗示「越用越厚」。',
    c1: '#fb7185',
    c2: '#be123c',
  },
]

function appIcon(candidate, size) {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${candidate.name}">
  <defs><linearGradient id="g-${candidate.key}-${size}" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${candidate.c1}"/><stop offset="1" stop-color="${candidate.c2}"/>
  </linearGradient></defs>
  <rect x="3" y="3" width="58" height="58" rx="17" fill="url(#g-${candidate.key}-${size})"/>
  ${motif(candidate.key, 'app')}
</svg>`
}

function glyph(candidate, size) {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${motif(candidate.key, 'glyph')}</svg>`
}

function motif(key, mode) {
  const stroke = mode === 'app' ? '#ffffff' : 'currentColor'
  if (key === 'A') {
    return `<g fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" opacity=".95">
      <path d="M32 19.5c-10.4 0-15 5.8-15 12.5s4.6 12.5 15 12.5"/>
      <path d="M32 19.5c10.4 0 15 5.8 15 12.5s-4.6 12.5-15 12.5"/></g>
      <circle cx="32" cy="32" r="5.4" fill="#fff"/><circle cx="32" cy="32" r="2.2" fill="${'#0f766e'}"/>
      <circle cx="17.6" cy="32" r="2.7" fill="#fff"/><circle cx="46.4" cy="32" r="2.7" fill="#fff"/>`
  }
  if (key === 'B') {
    return `<path d="M32 12c11 0 19 8 19 19s-8 17-17 17-14-6-14-14 5-12 11-12 9 4 9 9-3 7-7 7-5-2-5-5 1-3 3-3"
      fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>
      <circle cx="32" cy="32" r="4" fill="#fff"/>`
  }
  if (key === 'C') {
    return `<g stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none">
      <path d="M32 18 L20 41"/><path d="M32 18 L44 41"/><path d="M20 41 L44 41"/></g>
      <circle cx="32" cy="18" r="5" fill="#fff"/><circle cx="20" cy="41" r="4.4" fill="#fff"/><circle cx="44" cy="41" r="4.4" fill="#fff"/>`
  }
  if (key === 'D') {
    return `<g fill="#fff" opacity=".92">
      <rect x="14" y="24" width="28" height="24" rx="6" opacity=".45"/>
      <rect x="18" y="20" width="28" height="24" rx="6" opacity=".7"/>
      <rect x="22" y="16" width="26" height="24" rx="6"/></g>
      <path d="M46 18l1.6 3.9 3.9 1.6-3.9 1.6L46 29l-1.6-3.9-3.9-1.6 3.9-1.6z" fill="#fff"/>`
  }
  if (key === 'E') {
    return `<g fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" opacity=".95">
      <path d="M20 32a12 12 0 0 1 24 0"/><path d="M13 32a19 19 0 0 1 38 0" opacity=".6"/></g>
      <circle cx="32" cy="32" r="4.6" fill="#fff"/>`
  }
  return `<g fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round">
      <path d="M32 15a17 17 0 0 1 0 34" opacity=".95"/>
      <path d="M32 21a11 11 0 0 1 0 22" opacity=".75"/>
      <path d="M32 27a5 5 0 0 1 0 10" opacity=".55"/></g>
      <circle cx="32" cy="32" r="2.6" fill="#fff"/>`
}

export function galleryHtml() {
  const cards = CANDIDATES.map((candidate) => `
    <article class="card">
      <div class="head"><span class="key">${candidate.key}</span><h2>${candidate.name}</h2></div>
      <p class="note">${candidate.note}</p>
      <div class="row">
        <figure><div class="app big">${appIcon(candidate, 64)}</div><figcaption>64 安装/插件页</figcaption></figure>
        <figure><div class="app mid">${appIcon(candidate, 24)}</div><figcaption>24 面板头</figcaption></figure>
        <figure><div class="glyph">${glyph(candidate, 16)}</div><figcaption>16 侧栏</figcaption></figure>
        <figure><div class="glyph">${glyph(candidate, 24)}</div><figcaption>24 侧栏展开</figcaption></figure>
      </div>
    </article>`).join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>经验库图标候选</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px; background: #1b1b22; color: #ece9f2;
    font: 14px/1.6 ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .sub { color: #a9a4b8; margin: 0 0 22px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 16px; }
  .card { border: 1px solid #35333f; border-radius: 14px; padding: 16px 18px; background: #232229; }
  .head { display: flex; align-items: center; gap: 10px; }
  .key { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
    border-radius: 7px; background: #3a3846; font-weight: 700; font-size: 12px; }
  h2 { font-size: 14px; margin: 0; }
  .note { color: #a9a4b8; font-size: 12px; margin: 8px 0 14px; }
  .row { display: flex; align-items: flex-end; gap: 22px; }
  figure { margin: 0; text-align: center; }
  figcaption { color: #8f8a9e; font-size: 11px; margin-top: 8px; }
  .app { display: inline-flex; padding: 6px; border-radius: 10px; background: #1d1c23; }
  .glyph { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px;
    border-radius: 10px; background: #1d1c23; color: #cfc9dd; }
</style></head>
<body>
  <h1>经验库图标候选</h1>
  <p class="sub">每个候选给 64（安装/插件页）、24（面板头）、16 与 24（侧栏那格，用 currentColor 描边）。回复字母即可（比如「选 C」）。</p>
  <div class="grid">${cards}</div>
</body></html>`
}
