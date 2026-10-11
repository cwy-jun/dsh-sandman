// core/router.ts —— 路由（四步）：管"怎么查"。
// R1 项目词表命中 p=0.9 → R2 BM25/项目画像比对 → R3 模型仅在并列时兜底（M6 接入）。
// 按置信度选检索范围：≥0.75 只查命中项目 / 0.4~0.75 项目+全局 / <0.4 闲聊模式。
// 全带概率、全留痕、失败降级——R3 超时自动回退 R2 结果。

export interface LexiconEntry {
  projectId: string
  term: string
  weight: number
}

export interface ProjectBrief {
  id: string
  name: string
  profile: string
}

export interface Route3Verdict {
  projectId: string | null
  confidence: number
  reason: string
}

export interface RouterDeps {
  lexicon: LexiconEntry[]
  projects: ProjectBrief[]
  /** R2：消息与项目画像的相似度（0~1） */
  profileScore(message: string, projectId: string): number
  /** R3：模型兜底（可缺省；缺省时并列按 R2 第一名处理） */
  llm?: (message: string, top2: { id: string; score: number }[]) => Promise<Route3Verdict>
  /** R3 超时毫秒数（默认 2000） */
  r3TimeoutMs?: number
  /** 现在时间（测试可注入） */
  now?: () => number
}

export type RouteScope = 'project' | 'mixed' | 'chat'

export interface RouteResult {
  projectId: string | null
  conf: number
  scope: RouteScope
  r1Hit: boolean
  r2Top: { id: string; score: number }[]
  r3Used: boolean
  latencyMs: number
  note: string
  /** 供调用方原样写入 router_log 的行（不含自增 id 与时间戳） */
  logRow: {
    msg_hash: string
    project_id: string | null
    conf: number
    r1_hit: number
    r2_top: string
    r3_used: number
    scope: string
    latency_ms: number
  }
}

const R1_CONFIDENCE = 0.9
const SCOPE_PROJECT_MIN = 0.75
const SCOPE_CHAT_MAX = 0.4
const TIE_GAP = 0.1

export function route(
  message: string,
  deps: RouterDeps,
  hashOf: (text: string) => string,
): Promise<RouteResult> {
  return routeAsync(message, deps, hashOf)
}

async function routeAsync(message: string, deps: RouterDeps, hashOf: (text: string) => string): Promise<RouteResult> {
  const t0 = deps.now?.() ?? Date.now()
  const msg = String(message ?? '')

  // ── R1 项目词表命中 ──
  const lower = msg.toLowerCase()
  const hitWeight = new Map<string, number>()
  for (const e of deps.lexicon) {
    if (!e.term) continue
    if (lower.includes(e.term.toLowerCase())) {
      hitWeight.set(e.projectId, (hitWeight.get(e.projectId) ?? 0) + e.weight)
    }
  }
  if (hitWeight.size > 0) {
    const [projectId, w] = [...hitWeight.entries()].sort((a, b) => b[1] - a[1])[0]
    const conf = Math.min(0.99, R1_CONFIDENCE + 0.03 * (w - 1))
    return done({ projectId, conf, r1Hit: true, r2Top: [], r3Used: false, note: `R1：词表命中（权重 ${w.toFixed(1)}）` }, t0, msg, deps, hashOf)
  }

  // ── R2 项目画像比对 ──
  const scored = deps.projects
    .map((p) => ({ id: p.id, score: deps.profileScore(msg, p.id) }))
    .sort((a, b) => b.score - a.score)
  const top2 = scored.slice(0, 2)
  const best = top2[0]

  if (!best || best.score === 0) {
    return done({ projectId: null, conf: 0, r1Hit: false, r2Top: top2, r3Used: false, note: 'R2：无任何项目画像命中，判为闲聊' }, t0, msg, deps, hashOf)
  }

  // ── R3 模型兜底：仅 R1 未命中且 top1-top2 差 < 0.1 ──
  const gap = top2.length > 1 ? best.score - top2[1].score : 1
  if (gap < TIE_GAP && deps.llm) {
    const timeoutMs = deps.r3TimeoutMs ?? 2000
    try {
      const verdict = await withTimeout(deps.llm(msg, top2), timeoutMs, `R3 模型超时 ${timeoutMs}ms`)
      const conf = clamp01(verdict.confidence)
      return done(
        { projectId: verdict.projectId, conf, r1Hit: false, r2Top: top2, r3Used: true, note: `R3：模型判定 ${verdict.projectId ?? '闲聊'}（${verdict.reason}）` },
        t0,
        msg,
        deps,
        hashOf,
        verdict.projectId,
      )
    } catch {
      // R3 失败/超时：降级 R2 第一名
      return done({ projectId: best.id, conf: clamp01(best.score), r1Hit: false, r2Top: top2, r3Used: true, note: 'R3 超时/失败，降级采用 R2 第一名' }, t0, msg, deps, hashOf, best.id)
    }
  }

  return done({ projectId: best.id, conf: clamp01(best.score), r1Hit: false, r2Top: top2, r3Used: false, note: `R2：画像比对第一名 ${best.id}（${best.score.toFixed(2)}）` }, t0, msg, deps, hashOf, best.id)
}

function done(
  partial: {
    projectId: string | null
    conf: number
    r1Hit: boolean
    r2Top: { id: string; score: number }[]
    r3Used: boolean
    note: string
  },
  t0: number,
  msg: string,
  deps: RouterDeps,
  hashOf: (text: string) => string,
  logProjectId?: string | null,
): RouteResult {
  const scope: RouteScope = partial.conf >= SCOPE_PROJECT_MIN ? 'project' : partial.conf > SCOPE_CHAT_MAX ? 'mixed' : 'chat'
  const latencyMs = (deps.now?.() ?? Date.now()) - t0
  return {
    projectId: partial.projectId,
    conf: partial.conf,
    scope,
    r1Hit: partial.r1Hit,
    r2Top: partial.r2Top,
    r3Used: partial.r3Used,
    latencyMs,
    note: `${partial.note}；scope=${scope}`,
    logRow: {
      msg_hash: hashOf(msg),
      project_id: logProjectId === undefined ? partial.projectId : logProjectId,
      conf: partial.conf,
      r1_hit: partial.r1Hit ? 1 : 0,
      r2_top: JSON.stringify(partial.r2Top),
      r3_used: partial.r3Used ? 1 : 0,
      scope,
      latency_ms: latencyMs,
    },
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
