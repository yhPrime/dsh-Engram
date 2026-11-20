#!/usr/bin/env node
/**
 * 关系图性能读数汇总（P3）：读 `~/.dsh/engram/graph-perf.jsonl`，按节点规模给出 p50/p95/fps。
 *
 * 用法：node tools/graph-perf-report.mjs [file]
 *   file 缺省 = $DSH_HOME/engram/graph-perf.jsonl（再缺省 ~/.dsh）
 *
 * 只读：不改任何文件。没有记录时打印提示并以 0 退出（不算失败）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultPerfFile() {
  const home = process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
    ? String(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'engram', 'graph-perf.jsonl')
}

export function readSamples(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const p95 = Number(row.p95)
      if (!Number.isFinite(p95) || p95 <= 0) continue
      out.push({
        at: String(row.at || ''),
        nodes: Number(row.nodes) || 0,
        edges: Number(row.edges) || 0,
        fps: Number(row.fps) || 0,
        p50: Number(row.p50) || 0,
        p95,
        tier: String(row.tier || ''),
      })
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 分位数（线性插值，n≥1）。 */
export function percentile(values, ratio) {
  const list = Array.isArray(values) ? values.map(Number).filter((value) => Number.isFinite(value)).sort((a, b) => a - b) : []
  if (list.length === 0) return 0
  const index = (list.length - 1) * Math.max(0, Math.min(1, Number(ratio) || 0))
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return list[low]
  return list[low] + (list[high] - list[low]) * (index - low)
}

/** 汇总：总体与「最大节点规模」一档（验收看当前库规模那一档）。 */
export function summarize(samples) {
  const list = Array.isArray(samples) ? samples : []
  if (list.length === 0) return { count: 0, all: null, largest: null }
  const byNodes = new Map()
  for (const sample of list) {
    const key = sample.nodes
    if (!byNodes.has(key)) byNodes.set(key, [])
    byNodes.get(key).push(sample)
  }
  const maxNodes = Math.max(...byNodes.keys())
  const pick = (bucket, nodesLabel) => ({
    nodes: nodesLabel === undefined ? bucket[0].nodes : nodesLabel,
    count: bucket.length,
    p50: Math.round(percentile(bucket.map((item) => item.p50), 0.5) * 100) / 100,
    p95: Math.round(percentile(bucket.map((item) => item.p95), 0.95) * 100) / 100,
    p95max: Math.round(Math.max(...bucket.map((item) => item.p95)) * 100) / 100,
    fps: Math.round(percentile(bucket.map((item) => item.fps), 0.5)),
  })
  return { count: list.length, all: pick(list, 0), largest: pick(byNodes.get(maxNodes)) }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('graph-perf-report.mjs')) {
  const file = process.argv[2] || defaultPerfFile()
  const samples = readSamples(file)
  if (samples.length === 0) {
    console.log(`没有性能记录：${file}`)
    console.log('先在页面打开 `?graphPerf=1`，拖/转一会儿让页面 POST /graph-perf，再回来跑这个脚本。')
    process.exit(0)
  }
  const summary = summarize(samples)
  const line = (label, item) => (item.nodes > 0
    ? `${label}：${item.nodes} 节点 / ${item.count} 条 · p50 ${item.p50}ms · p95 ${item.p95}ms（最差 ${item.p95max}ms）· 中位 fps ${item.fps}`
    : `${label}：${item.count} 条 · p50 ${item.p50}ms · p95 ${item.p95}ms（最差 ${item.p95max}ms）· 中位 fps ${item.fps}`)
  console.log(`记录文件：${file}`)
  console.log(`共 ${summary.count} 条样本（最近一条 ${samples[samples.length - 1].at}）`)
  console.log(line('最大规模档', summary.largest))
  console.log(line('全量', summary.all))
}
