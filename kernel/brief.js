/**
 * 待判定摘要（pending brief）：把「上一轮意图 + 用户随后说了什么 + 手改了什么」
 * 压成 ≤80 字符的一句话，放进下一次工具回执里给模型看。
 *
 * 只做截取与拼接，**不做任何判断**——判不判、判成什么，是模型的事。
 */

export const MAX_BRIEF_CHARS = 80

function cut(text, max) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/gu, ' ').trim()
  if (value === '') return ''
  // 按码点截断：直接 slice 会把 emoji 的代理对劈成孤立半截（实测输出 \ud83d）。
  return value.length <= max ? value : `${Array.from(value).slice(0, Math.max(0, max - 1)).join('')}…`
}

/**
 * @param {{intent?: string}} experience
 * @param {{quote?: string, edit?: string}} [options] quote=用户随后原话；edit=手改摘要
 * @returns {string} ≤80 字符
 */
export function pendingBrief(experience = {}, options = {}) {
  const intent = cut(experience && experience.intent, 26)
  const quote = cut(options.quote, 30)
  const edit = cut(options.edit, 26)
  let text = intent === '' ? '上一轮任务' : `上一轮：${intent}`
  if (quote !== '') text += ` → 用户：${quote}`
  if (edit !== '') text += ` → 手改：${edit}`
  return text.length <= MAX_BRIEF_CHARS ? text : `${Array.from(text).slice(0, MAX_BRIEF_CHARS - 1).join('')}…`
}
