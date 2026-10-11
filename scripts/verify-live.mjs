// scripts/verify-live.mjs —— 对真实运行中的插件做全功能在线验收。
// 用法：node scripts/verify-live.mjs [baseUrl] [--full]
//   默认只做只读探针；--full 额外做个性化增删回环 + 轻梦触发（均有自清理，无副作用）。
//   baseUrl 默认 http://127.0.0.1:19387/dsh-sandman/api
const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:19387/dsh-sandman/api'
const FULL = process.argv.includes('--full')

const results = []
async function probe(name, fn) {
  try {
    const detail = await fn()
    results.push(['✅', name, detail])
  } catch (e) {
    results.push(['❌', name, String(e?.message ?? e).slice(0, 90)])
  }
}
async function get(p) {
  const r = await fetch(BASE + p)
  const d = await r.json()
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}
async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })
  const d = await r.json()
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

await probe('总览 /overview（库+注入+捕获）', async () => {
  const d = await get('/overview')
  return `记忆 ${d.counts.total} · 项目 ${d.counts.projects} · 注入 ${d.inject?.tokens ?? '?'}tok · 捕获 ${d.capture ? d.capture.kept + d.capture.pending : 'n/a'}`
})
await probe('配置 /config 可读', async () => {
  const d = await get('/config')
  return `注入开关 ${d.config.injectEnabled ? '开' : '关'} · 馆长模式 ${d.config.curator?.mode ?? 'dsh'}`
})
await probe('个性化 /persona（v3 新增）', async () => {
  const d = await get('/persona')
  return `${(d.items ?? []).length} 条指令`
})
await probe('馆长对话历史 /curator/chat（v3 新增）', async () => {
  const d = await get('/curator/chat')
  return `${(d.items ?? []).length} 条持久化对话`
})
await probe('项目对话流水 /curator/sessions（v3 新增）', async () => {
  const d = await get('/curator/sessions?limit=5')
  return `${(d.items ?? []).length} 行流水`
})
await probe('做梦 /dream/status + /dream/runs', async () => {
  const s = await get('/dream/status')
  const r = await get('/dream/runs')
  return `锁 ${s.lock.holder ? '被持有' : '空闲'} · 历史做梦 ${r.items.length} 次`
})
await probe('梦境日记 /dreams-journal', async () => (await get('/dreams-journal')).md ? `${(await get('/dreams-journal')).md.length} 字` : '（还没跑过深梦）')
await probe('审核队列 /review/pending + /review/failures', async () => {
  const p = await get('/review/pending')
  const f = await get('/review/failures')
  return `待审 ${p.items.length} · 失败 ${f.items.length}`
})
await probe('路由判定留痕 /route/recent', async () => {
  const d = await get('/route/recent')
  return `${d.items.length} 条路由记录`
})
await probe('快照列表 /snapshots', async () => {
  const d = await get('/snapshots')
  return `${(d.items ?? []).length} 个快照`
})

if (FULL) {
  let pid = null
  await probe('个性化增删回环（--full）', async () => {
    const created = await post('/persona', { scope: 'global', content: '[验收临时条目，自动删除]' })
    pid = created.item.id
    const got = await get('/persona')
    if (!got.items.some((i) => i.id === pid)) throw new Error('写入后读不到')
    await post('/persona', { id: pid, enabled: false })
    await post('/persona/delete', { id: pid })
    return '增→读→停用→删 全通过'
  })
  await probe('轻梦触发（--full，空跑安全）', async () => {
    const d = await post('/dream/run', { kind: 'light' })
    return `run#${d.run.id}：${String(d.run.receipt).slice(0, 60)}`
  })
  await probe('馆长问答（--full，会进对话历史）', async () => {
    const d = await post('/curator/ask', { q: '验收探针：我的画像里有几条记忆？' })
    return `${d.usedModel ? '模型' : '直引'}：${String(d.answer).slice(0, 60)}`
  })
}

let ok = 0
for (const [mark, name, detail] of results) {
  console.log(`${mark} ${name}  →  ${detail}`)
  if (mark === '✅') ok++
}
console.log(`\n合计 ${ok}/${results.length} 项通过${ok < results.length ? '（若 ❌ 是 v3 新增项，请完全退出并重启 DeepSeek Harness 后重跑）' : ''}`)
