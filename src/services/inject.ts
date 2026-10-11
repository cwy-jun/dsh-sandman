// services/inject.ts —— 注入装配（M3 实装）。
// 静态段：画像层常驻（≤30 条 × ≤200 字，预算硬约束）。
// 动态段：按最近一轮路由结果装配——项目命中 → 项目 top-K；文库关键词 top-K；
//         契合度 <0.5 的记忆丢弃（防跨项目污染）；F3 永不注入。
// 与旧记忆栈的红线：injectEnabled 默认 false（喵记忆/记忆核心已是注入通道，M7 迁移后再切）。
import type { Store, MemoryRow } from '../store/db.js'
import { bigramContainment } from '../core/bm25.js'
import type { RouteResult } from '../core/router.js'

export interface InjectPlan {
  staticSection: string
  dynamic: { id: string; title: string; content: string }[]
  stats: { tokens: number; count: number; budgetMax: number }
  source: 'none' | 'project' | 'mixed' | 'chat'
}

export interface InjectOptions {
  profileBudgetMax: number
  profileBudgetChars: number
  projectTopK?: number
  libraryTopK?: number
  fitThreshold?: number
}

export const DEFAULT_INJECT_OPTS: InjectOptions = { profileBudgetMax: 30, profileBudgetChars: 200, projectTopK: 8, libraryTopK: 5, fitThreshold: 0.5 }

/** 个性化段落（v3）：全局指令常驻；工作区指令按命中注入。
 *  matchText = 最近用户文本 + 命中的项目名/ID（大小写不敏感子串匹配）。 */
export function personaSection(store: Store, matchText = ''): { text: string; count: number; tokens: number } {
  const rows = store.listPersonalization(true)
  const hay = String(matchText ?? '').toLowerCase()
  const kept: string[] = []
  for (const r of rows) {
    const content = String(r.content ?? '').trim()
    if (!content) continue
    if (String(r.scope) === 'global') {
      kept.push(`- ${content}`)
      continue
    }
    // 工作区指令：关键词命中最近文本或项目名才注入（跨项目对话不受污染）；逗号分隔多关键词
    const rawKeys = [String(r.match ?? ''), String(r.workspace ?? '')]
    const keys = rawKeys.flatMap((s) => s.split(/[,，、;；]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (!keys.length) continue
    if (keys.some((k) => hay.includes(k))) kept.push(`- ${content}`)
  }
  if (!kept.length) return { text: '', count: 0, tokens: 0 }
  const text = `【个性化指令 · 用户指定】\n${kept.join('\n')}`
  return { text, count: kept.length, tokens: Math.ceil(text.length / 2) }
}

/** 静态段：画像层常驻（M1 即真实，预算硬约束）+ 个性化指令 */
export function planInjection(store: Store, opts: InjectOptions): InjectPlan {
  const rows = store.listMemories({ level: 0, status: 'active', limit: opts.profileBudgetMax })
  const kept: string[] = []
  let tokens = 0
  for (const r of rows) {
    const content = String(r.content)
    const clipped = content.length > opts.profileBudgetChars ? content.slice(0, opts.profileBudgetChars) + '…' : content
    const line = `- ${String(r.title)}：${clipped}`
    kept.push(line)
    tokens += Math.ceil(line.length / 2)
  }
  return {
    staticSection: kept.length ? `【画像 · 九层之台】\n${kept.join('\n')}` : '',
    dynamic: [],
    stats: { tokens, count: kept.length, budgetMax: opts.profileBudgetMax },
    source: 'none',
  }
}

/** 动态段：按路由结果装配（M3 核心） */
export function planDynamicInjection(
  store: Store,
  lastRoute: RouteResult | null,
  lastUserText: string,
  opts: InjectOptions = DEFAULT_INJECT_OPTS,
): { items: { id: string; title: string; content: string }[]; dropped: number } {
  const items: { id: string; title: string; content: string }[] = []
  let dropped = 0
  const fitOk = (m: MemoryRow) => {
    if (!lastRoute?.projectId) return true
    // 契合度 = 项目画像被本条记忆覆盖的程度（短画像 vs 长记忆，用覆盖度而非 Dice）
    const fit = bigramContainment(projectProfileText(store, lastRoute.projectId), `${m.title}\n${m.content}`)
    if (fit < (opts.fitThreshold ?? 0.5)) {
      dropped++
      return false
    }
    return true
  }

  if (lastRoute && (lastRoute.scope === 'project' || lastRoute.scope === 'mixed') && lastRoute.projectId) {
    for (const m of store.topProjectCards(lastRoute.projectId, opts.projectTopK ?? 8)) {
      if (!fitOk(m)) continue
      items.push({ id: m.id, title: String(m.title), content: String(m.content).slice(0, 200) })
      store.touchAccess(m.id)
    }
  }
  // 文库 top-K：关键词命中（BM25/FTS）+ heat 排序
  if (lastUserText.trim()) {
    for (const m of store.searchCards(lastUserText, opts.libraryTopK ?? 5)) {
      if (m.level !== 2) continue
      if (items.some((i) => i.id === m.id)) continue
      items.push({ id: m.id, title: String(m.title), content: String(m.content).slice(0, 200) })
      store.touchAccess(m.id)
    }
  }
  return { items: items.slice(0, (opts.projectTopK ?? 8) + (opts.libraryTopK ?? 5)), dropped }
}

function projectProfileText(store: Store, projectId: string): string {
  const row = store.listProjects().find((p) => p.id === projectId)
  return row?.profile ?? ''
}

/** 汇总成最终注入文本（systemPrompt 分段用；宿主每次渲染现调，天然新鲜） */
export function composeInjection(store: Store, lastRoute: RouteResult | null, lastUserText: string, opts: InjectOptions): InjectPlan {
  const base = planInjection(store, opts)
  const dyn = planDynamicInjection(store, lastRoute, lastUserText, opts)
  // 个性化：全局常驻；工作区指令按「最近文本 + 命中项目名/ID」匹配
  const routedName = lastRoute?.projectId ? store.listProjects().find((p) => p.id === lastRoute.projectId)?.name ?? '' : ''
  const persona = personaSection(store, `${lastUserText ?? ''}\n${routedName}\n${lastRoute?.projectId ?? ''}`)
  const sections: string[] = []
  if (persona.text) sections.push(persona.text)
  if (base.staticSection) sections.push(base.staticSection)
  if (dyn.items.length) {
    sections.push(
      '【相关记忆 · 九层之台】\n' +
        dyn.items.map((i) => `- ${i.title}：${i.content.length > 160 ? i.content.slice(0, 160) + '…' : i.content}`).join('\n'),
    )
  }
  return {
    staticSection: sections.join('\n\n'),
    dynamic: dyn.items,
    stats: { tokens: Math.ceil(sections.join('').length / 2), count: dyn.items.length + base.stats.count + persona.count, budgetMax: opts.profileBudgetMax },
    source: lastRoute?.scope ?? 'none',
  }
}
