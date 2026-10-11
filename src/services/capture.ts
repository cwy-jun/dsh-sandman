// services/capture.ts —— 捕获引擎（M2 实装）：turn-stopping → 候选 → 写门 → 落库/审核。
// 真机血泪（交接文档 M3/M4）：0.2.x 的 Session 没有 events 数组，只有 snapshotEvents()；
// llm.stream() 失败不抛异常只回 finish/error。本模块全部按取证过的写法处理。
// 纪律：turn-stopping 是 serial 事件，监听器里只同步抓取快照，重活全部排进后台队列。
import { gate, normalizeText, type Candidate, type GateResult, type Gate3Verdict } from '../core/gating.js'
import { route, type RouteResult } from '../core/router.js'
import { tokenize } from '../core/bm25.js'
import { Store } from '../store/db.js'

export interface CaptureConfig {
  enabled: boolean
  captureMinChars: number
  captureCooldownMs: number
  maxCapturesPerDay: number
  auditMode: string // all | none
  autoApproveLowRiskLimit: number
}

export interface TurnPayload {
  userText: string
  assistantText: string
  sessionId?: string
}

export interface CaptureOutcome {
  result: GateResult
  route: RouteResult | null
  memoryId?: string
}

export interface CaptureDeps {
  store: Store
  getCfg: () => CaptureConfig
  /** 门3 裁决（M6 馆长快模型；缺省时拿不准的转人审） */
  gate3?: (cand: Candidate, top: { id: string; sim: number }[]) => Promise<Gate3Verdict>
  log?: (msg: string) => void
}

/** 从宿主事件数组抽出「用户问 + 助手答」的纯文本（与 memory-eternal 取证一致的口径） */
export function extractTurnText(events: unknown[]): { user: string; assistant: string } {
  let user = ''
  let assistant = ''
  const push = (role: string, content: unknown) => {
    const text = blocksToText(content)
    if (!text) return
    if (role === 'user') user = user ? `${user}\n${text}` : text
    else assistant = assistant ? `${assistant}\n${text}` : text
  }
  for (const event of events) {
    const e = event as Record<string, unknown>
    const data = (e.data ?? e) as Record<string, unknown>
    const message = (data.message ?? data) as Record<string, unknown>
    const role = message.role
    const type = e.type
    if (type === 'user/message' || (type === 'message' && role === 'user')) push('user', message.content)
    else if (type === 'assistant/message') push('assistant', message.content)
    else if (type === 'assistant/chunk') {
      const chunk = data.chunk as Record<string, unknown> | undefined
      if (chunk?.content) push('assistant', chunk.content)
    }
  }
  return { user: user.trim(), assistant: assistant.trim() }
}

function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join('\n').trim()
  }
  return ''
}

/** 事件增量切片（按 seq） */
export function sliceNewEvents(events: unknown[], lastSeq: number): unknown[] {
  const out: unknown[] = []
  for (const event of events) {
    const e = event as { seq?: number; type?: string }
    if (e.seq !== undefined && e.seq <= lastSeq) continue
    if (e.type === 'user/message' || e.type === 'assistant/message') out.push(event)
  }
  return out
}

/** 关键词粗提取：正文里出现次数最多的 bigram 前 N 个（写门冲突检测/界面展示用） */
export function extractKeywords(text: string, n = 5): string[] {
  const freq = new Map<string, number>()
  for (const t of tokenize(text)) {
    if (t.length < 2) continue
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t)
}

export function createCaptureService(deps: CaptureDeps) {
  const { store, getCfg, gate3, log = () => {} } = deps
  const lastSeqs = new Map<string, number>()
  const lastCaptureAt = new Map<string, number>()
  let queue: Promise<unknown> = Promise.resolve()
  const stats = { turns: 0, captured: 0, kept: 0, duplicate: 0, merged: 0, pending: 0, rejected: 0, quarantined: 0, dropped: 0, split: 0 }

  async function processTurn(payload: TurnPayload): Promise<CaptureOutcome | null> {
    const cfg = getCfg()
    if (!cfg.enabled) return null
    // 归一化口径必须与写门一致（NFC + 空白压缩）：查重哈希按归一化文本算
    const text = normalizeText(`${payload.userText}\n${payload.assistantText}`)
    if (text.length < cfg.captureMinChars) return null
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    if (store.capturesSince(dayStart.getTime()) >= cfg.maxCapturesPerDay) return null

    // M3 路由：判这句话属于哪个项目域（全程留痕 router_log）
    let routed: RouteResult | null = null
    try {
      routed = await route(payload.userText, store.routerDeps(), (t) => Store.hash(t))
      store.logRouter({ ...routed.logRow, hits_n: 0, filtered_n: 0 } as never)
    } catch (error) {
      log(`路由判定失败（按全局处理）：${String((error as Error)?.message ?? error)}`)
    }

    const cand: Candidate = {
      text,
      title: payload.userText.slice(0, 40),
      source: 'capture',
      level: routed?.scope === 'project' && routed.projectId ? 1 : 3,
      projectId: routed?.projectId ?? null,
    }

    // 项目对话流水（v3）：馆长"看见项目对话"的数据底座。失败不影响主流程。
    try {
      store.appendSessionTurn(payload.sessionId ?? 'unknown', payload.userText, payload.assistantText, routed?.projectId ?? null)
    } catch (error) {
      log(`对话流水记录失败（跳过）：${String((error as Error)?.message ?? error)}`)
    }
    const result = await gate(cand, withGate3(store, gate3), (t) => Store.hash(t))
    store.logGating(result.logRow)

    const statusFor = () => (cfg.auditMode === 'none' ? 'active' : 'pending')
    let memoryId: string | undefined
    switch (result.final) {
      case 'keep':
        stats.kept++
        memoryId = (store.insertMemory({
          level: cand.level ?? 3,
          slot: cand.level === 1 ? 'ops' : null,
          projectId: cand.projectId ?? null,
          title: cand.title ?? text.slice(0, 40),
          content: text,
          keywords: extractKeywords(text),
          importance: 2,
          status: statusFor(),
          source: 'capture',
        }, 'system', `写门 keep（${result.note}）`).id as string)
        break
      case 'duplicate':
      case 'merge':
        if (result.targetId) store.touchAccess(result.targetId)
        if (result.final === 'duplicate') stats.duplicate++
        else stats.merged++
        break
      case 'quarantine':
        stats.quarantined++
        memoryId = (store.insertMemory({
          level: 3, slot: null, projectId: null,
          title: `隔离：${(cand.title ?? text.slice(0, 40)).slice(0, 36)}`,
          content: text,
          keywords: ['隔离区'],
          importance: 1,
          status: 'quarantine',
          source: 'capture',
        }, 'system', `投毒隔离（${result.note}）`).id as string)
        break
      case 'pending':
        stats.pending++
        memoryId = (store.insertMemory({
          level: cand.level ?? 3,
          slot: cand.level === 1 ? 'ops' : null,
          projectId: cand.projectId ?? null,
          title: cand.title ?? text.slice(0, 40),
          content: text,
          keywords: extractKeywords(text),
          importance: 2,
          status: 'pending',
          source: 'capture',
        }, 'system', `写门转人审（${result.note}）`).id as string)
        break
      case 'reject':
        stats.rejected++
        break
      case 'split': {
        stats.split++
        // 拆分重跑：每块 ≤2000 字，独立过门（防单条超长内容整体丢失）
        const chunks = text.match(/[\s\S]{1,1800}/g) ?? []
        for (const chunk of chunks) {
          const sub = await gate({ ...cand, text: chunk }, withGate3(store, gate3), (t) => Store.hash(t))
          store.logGating(sub.logRow)
          if (sub.final === 'keep') {
            store.insertMemory({ level: 3, slot: null, projectId: null, title: `${(cand.title ?? '长文').slice(0, 30)}（拆分）`, content: chunk, keywords: extractKeywords(chunk), status: statusFor(), source: 'capture' }, 'system', '拆分块自动入库')
          }
        }
        break
      }
      default:
        stats.dropped++
    }
    stats.captured++
    return { result, route: routed, memoryId }
  }

  return {
    stats,
    /** 最近一轮的路由结果与用户文本（注入装配用） */
    state: { lastRoute: null as RouteResult | null, lastUserText: '' as string },

    /** 手动喂一轮（测试 / 无宿主环境演示用） */
    submitTurn(payload: TurnPayload): Promise<CaptureOutcome | null> {
      stats.turns++
      this.state.lastUserText = payload.userText
      queue = queue.then(() => processTurn(payload)).then((out) => {
        if (out?.route) this.state.lastRoute = out.route
        return out
      }).catch((error) => {
        log(`捕获队列失败：${String((error as Error)?.stack ?? error)}`)
        return null
      })
      return queue as Promise<CaptureOutcome | null>
    },

    /** 订阅 DSH turn-stopping（0.2.x 事件口径，memory-eternal 取证写法） */
    attach(ctx: { on?: (event: string, cb: (payload: { agent?: { session?: { id?: string; events?: unknown[]; snapshotEvents?: () => unknown[] } } }) => void) => void }) {
      if (typeof ctx?.on !== 'function') {
        log('宿主没有 ctx.on，捕获引擎以手动模式待机')
        return
      }
      ctx.on('agent/turn-stopping', ({ agent }) => {
        try {
          stats.turns++
          const session = agent?.session as { id?: string; events?: unknown[]; snapshotEvents?: () => unknown[] } | undefined
          const events = Array.isArray(session?.events)
            ? session.events
            : session && typeof session.snapshotEvents === 'function'
              ? session.snapshotEvents()
              : undefined
          if (!Array.isArray(events)) return
          const sessionId = session?.id ?? 'unknown'
          const lastSeq = lastSeqs.get(sessionId) ?? 0
          const fresh = sliceNewEvents(events, lastSeq)
          // lastSeq 取本轮见到的最大 seq（不假设数组有序）
          let maxSeq = lastSeq
          for (const ev of events) {
            const s = (ev as { seq?: number }).seq
            if (typeof s === 'number' && s > maxSeq) maxSeq = s
          }
          lastSeqs.set(sessionId, maxSeq)
          if (fresh.length === 0) return
          const now = Date.now()
          const lastAt = lastCaptureAt.get(sessionId) ?? 0
          const { user, assistant } = extractTurnText(fresh)
          if (!user) return
          if (now - lastAt < getCfg().captureCooldownMs) return
          lastCaptureAt.set(sessionId, now)
          this.state.lastUserText = user
          queue = queue.then(() => processTurn({ userText: user, assistantText: assistant, sessionId })).then((out) => {
            if (out?.route) this.state.lastRoute = out.route
            return out
          }).catch((error) => {
            log(`捕获失败：${String((error as Error)?.message ?? error)}`)
            return null
          })
        } catch (error) {
          log(`turn-stopping 处理异常（已吞掉，不影响宿主）：${String((error as Error)?.message ?? error)}`)
        }
      })
      log('捕获引擎已订阅 agent/turn-stopping')
    },
  }
}

/** gate3 包装：把 store 语料检索注入门3 回调（模型输入 = 候选 + top 相似卡） */
function withGate3(store: Store, gate3?: CaptureDeps['gate3']) {
  const deps = store.gateDeps()
  return {
    findByHash: deps.findByHash,
    searchSimilar: deps.searchSimilar,
    profileConflict: deps.profileConflict,
    llm: gate3,
  }
}

export type CaptureService = ReturnType<typeof createCaptureService>
