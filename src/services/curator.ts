// services/curator.ts —— 记忆馆长（M6 实装）：LLM 客户端三模式 + 日预算熔断
// + 记忆问答（RAG-lite）+ 调参治理提案。
// 三模式：dsh（DSH 主路由，宿主内）/ cloud（OpenAI 兼容 API）/ local（本地 Ollama）。
// 降级纪律：任何模型环节失败都向上抛，由调用方决定转规则/转人审——馆长自己不静默。
import type { Store, MemoryRow } from '../store/db.js'

export type CuratorMode =
  | { kind: 'dsh' }
  | { kind: 'cloud'; baseUrl: string; apiKey: string; model: string }
  | { kind: 'local'; baseUrl: string; model: string }

/** 容错解析：用户配错不炸，给出 dsh 默认 + 诊断 */
export function parseCuratorMode(raw: unknown): { mode: CuratorMode; warnings: string[] } {
  const warnings: string[] = []
  const c = (raw ?? {}) as Record<string, unknown>
  const kind = String(c.mode ?? 'dsh').toLowerCase()
  if (kind === 'cloud') {
    const baseUrl = String(c.baseUrl ?? '').replace(/\/+$/, '')
    const apiKey = String(c.apiKey ?? '')
    const model = String(c.model ?? '')
    if (!baseUrl) warnings.push('cloud 模式缺 baseUrl（示例 https://api.deepseek.com）')
    if (!apiKey) warnings.push('cloud 模式缺 apiKey')
    if (!model) warnings.push('cloud 模式缺 model（示例 deepseek-chat）')
    return { mode: { kind: 'cloud', baseUrl, apiKey, model }, warnings }
  }
  if (kind === 'local') {
    const baseUrl = String(c.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '') || 'http://127.0.0.1:11434'
    const model = String(c.model ?? '')
    if (!model) warnings.push('local 模式缺 model（示例 qwen2.5:3b）；Ollama 可用 ollama list 查看')
    return { mode: { kind: 'local', baseUrl, model }, warnings }
  }
  if (kind !== 'dsh') warnings.push(`未知 mode ${JSON.stringify(kind)}，回退 dsh（DSH 主路由）`)
  return { mode: { kind: 'dsh' }, warnings }
}

export interface SelfCheckResult {
  ok: boolean
  mode: string
  detail: string
}

/** 连通性自检。fetchImpl 可注入（测试用）；cloud 打 /models，local 打 /api/tags，dsh 由宿主保证。 */
export async function selfCheck(mode: CuratorMode, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<SelfCheckResult> {
  const timeoutMs = opts.timeoutMs ?? 3000
  const doFetch = opts.fetchImpl ?? fetch
  if (mode.kind === 'dsh') {
    return { ok: true, mode: 'dsh', detail: '使用 DSH 主路由模型（宿主内提供，无需外部网络）' }
  }
  if (mode.kind === 'cloud') {
    if (!mode.baseUrl) return { ok: false, mode: 'cloud', detail: 'baseUrl 为空' }
    try {
      const res = await withTimeout(doFetch(`${mode.baseUrl}/models`, { headers: { Authorization: `Bearer ${mode.apiKey}` } }), timeoutMs)
      if (!res.ok) return { ok: false, mode: 'cloud', detail: `HTTP ${res.status}` }
      return { ok: true, mode: 'cloud', detail: `云端 API 可达（${mode.model || '未指定模型'}）` }
    } catch (e) {
      return { ok: false, mode: 'cloud', detail: `不可达：${String((e as Error)?.message ?? e)}` }
    }
  }
  try {
    const res = await withTimeout(doFetch(`${mode.baseUrl}/api/tags`), timeoutMs)
    if (!res.ok) return { ok: false, mode: 'local', detail: `HTTP ${res.status}` }
    return { ok: true, mode: 'local', detail: `Ollama 可达（${mode.model || '未指定模型'}）` }
  } catch (e) {
    return { ok: false, mode: 'local', detail: `Ollama 不可达（${mode.baseUrl}）：${String((e as Error)?.message ?? e)}` }
  }
}

/** 日预算熔断：馆长每天最多花多少 token，超出即拒绝调用 */
export class BudgetTracker {
  private used: number
  private day: string
  constructor(private dailyLimit: number, used = 0, day?: string) {
    this.used = used
    this.day = day ?? today()
  }
  private resetIfNewDay() {
    const t = today()
    if (t !== this.day) {
      this.day = t
      this.used = 0
    }
  }
  allow(costTokens: number): boolean {
    this.resetIfNewDay()
    if (this.used + costTokens > this.dailyLimit) return false
    this.used += costTokens
    return true
  }
  snapshot() {
    this.resetIfNewDay()
    return { day: this.day, used: this.used, limit: this.dailyLimit }
  }
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function withTimeout<T>(p: Promise<T>, ms: number, label = `超时 ${ms}ms`): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// ───────────────────────── LLM 客户端 ─────────────────────────

export interface ChatOptions {
  system: string
  user: string
  maxTokens?: number
  purpose?: string
  timeoutMs?: number
}

export interface CuratorDeps {
  getMode: () => CuratorMode
  dailyBudget: () => number
  /** dsh 模式专用：宿主 llm 服务 + 当前模型路由（agentDefaultModel，取证自 memory-eternal M4 修复） */
  getLlm?: () => { llm: any; route: { provider: string; model: string } } | null
  fetchImpl?: typeof fetch
  log?: (msg: string) => void
}

export class Curator {
  private tracker: BudgetTracker
  private log: (msg: string) => void
  constructor(private deps: CuratorDeps) {
    this.tracker = new BudgetTracker(deps.dailyBudget())
    this.log = deps.log ?? (() => {})
  }

  budget() {
    return this.tracker.snapshot()
  }

  async chat(opts: ChatOptions): Promise<string> {
    this.tracker = new BudgetTracker(this.deps.dailyBudget(), this.tracker.snapshot().used, this.tracker.snapshot().day)
    const est = Math.ceil(opts.user.length / 2) + (opts.maxTokens ?? 800)
    if (!this.tracker.allow(est)) {
      throw new Error(`馆长日预算熔断（已用 ${this.tracker.snapshot().used}/${this.deps.dailyBudget()} tok，本次估算 ${est} tok）`)
    }
    const mode = this.deps.getMode()
    if (mode.kind === 'dsh') return this.chatDsh(opts)
    return this.chatOpenAiCompatible(mode, opts)
  }

  /** 模型是否可用（不可用 = 全系统按规则降级，永不卡死） */
  async available(): Promise<boolean> {
    const check = await selfCheck(this.deps.getMode(), { fetchImpl: this.deps.fetchImpl, timeoutMs: 2000 })
    return check.ok
  }

  private async chatDsh(opts: ChatOptions): Promise<string> {
    const got = this.deps.getLlm?.()
    if (!got?.llm) throw new Error('dsh 模式：宿主 llm 服务未就绪')
    const { BlockAssembler, createUserMessage } = await importLlmHelpers()
    const assembler = new BlockAssembler()
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: opts.user }],
        source: { kind: 'plugin', plugin: 'dsh-sandman' },
      }),
    ]
    let finishKind = ''
    let streamError: Error | null = null
    for await (const chunk of got.llm.stream({
      provider: got.route.provider,
      model: got.route.model,
      messages,
      system: opts.system,
      maxTokens: opts.maxTokens ?? 800,
      reasoningEffort: 'off',
      purpose: opts.purpose ?? 'sandman-curator',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 45000),
    })) {
      const reason = (chunk as { type?: string; reason?: { kind?: string; failure?: { message?: string } } })?.type === 'finish'
        ? (chunk as { reason?: { kind?: string; failure?: { message?: string } } }).reason
        : null
      if (reason?.kind) finishKind = String(reason.kind)
      // 关键坑（真机取证）：llm.stream() 失败不抛异常，只回 finish/error——必须显式抛
      if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
        streamError = new Error(`${got.route.provider}/${got.route.model}: ${reason.failure?.message ?? `stream ${reason.kind}`}`)
        break
      }
      assembler.push(chunk)
    }
    if (streamError) throw streamError
    const out = assembler
      .blocks()
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('')
      .trim()
    if (!out) throw new Error(`dsh 馆长返回空输出（finishKind=${finishKind || 'none'}）`)
    return out
  }

  private async chatOpenAiCompatible(mode: Extract<CuratorMode, { kind: 'cloud' | 'local' }>, opts: ChatOptions): Promise<string> {
    const doFetch = this.deps.fetchImpl ?? fetch
    const base = mode.kind === 'local' && !mode.baseUrl.includes('/v1') ? `${mode.baseUrl}/v1` : mode.baseUrl
    const res = await withTimeout(
      doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(mode.kind === 'cloud' ? { authorization: `Bearer ${(mode as { apiKey?: string }).apiKey ?? ''}` } : {}),
        },
        body: JSON.stringify({
          model: mode.model,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
          max_tokens: opts.maxTokens ?? 800,
          temperature: 0.3,
          stream: false,
        }),
      }),
      opts.timeoutMs ?? 30000,
    )
    if (!res.ok) throw new Error(`馆长 API HTTP ${res.status}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const out = data.choices?.[0]?.message?.content?.trim()
    if (!out) throw new Error('馆长 API 返回空内容')
    return out
  }

  // ───────────────────────── 记忆问答（RAG-lite）─────────────────────────

  /** 你问它答：检索 top 卡作上下文 + 保留原则系统提示词。无模型时退化为「卡片直引」。
   *  检索双通道：searchCards(OR 召回) 为空时回退 listMemories(AND 精确)，宁可多试不可漏。
   *  history：馆长对话的近期历史（持久化于 curator_chat 表），切会话/重载面板不丢。 */
  async ask(
    store: Store,
    question: string,
    history: { role: string; content: string }[] = [],
    dialogue = '',
  ): Promise<{ answer: string; sources: MemoryRow[]; usedModel: boolean }> {
    let sources = store.searchCards(question, 6)
    if (sources.length === 0) {
      sources = store.listMemories({ q: question, status: 'active', limit: 6 })
    }
    const context = sources.map((m, i) => `${i + 1}. [${m.title}]（层级${m.level} · heat ${Number(m.heat).toFixed(2)}）\n${String(m.content).slice(0, 300)}`).join('\n\n')
    const system = [
      '你是「九层之台」记忆馆长，负责回答用户关于自己记忆库的问题。',
      '保留原则（写死，不可违背）：保留每个事实；不确定就说不确定；绝不编造记忆库里没有的内容。',
      '回答要求：先给结论，再给依据；引用记忆时标注 [标题]。检索结果为空就直说"记忆库没有相关内容"。',
    ].join('\n')
    // 近期对话（最多 8 轮），让馆长"记得"之前聊过什么
    const recent = history.filter((h) => h && h.content).slice(-8)
    const historyText = recent.length
      ? `\n\n近期对话历史（旧→新）：\n${recent.map((h) => `${h.role === 'user' ? '用户' : '馆长'}：${String(h.content).slice(0, 220)}`).join('\n')}`
      : ''
    // 项目对话摘录：馆长能"看见"你在项目里聊了什么（来自 session_log 流水）
    const dialogueText = dialogue ? `\n\n近期项目对话摘录（旧→新）：\n${dialogue}` : ''
    const user = `记忆库检索结果：\n${context || '（空）'}${historyText}${dialogueText}\n\n用户问题：${question}`
    try {
      const answer = await this.chat({ system, user, maxTokens: 600, purpose: 'sandman-ask' })
      this.reinforce(store, sources, 1) // 检索驱动再巩固：被用来说理的记忆 = 被强化
      return { answer, sources, usedModel: true }
    } catch (error) {
      this.log(`馆长问答降级为卡片直引：${String((error as Error)?.message ?? error)}`)
      const fallback = sources.length
        ? `（模型不可用，以下为记忆库直引）\n${sources.map((m, i) => `${i + 1}. [${m.title}] ${String(m.content).slice(0, 200)}`).join('\n')}`
        : '记忆库没有相关内容，且馆长模型当前不可用。'
      return { answer: fallback, sources, usedModel: false }
    }
  }

  // ───────────────────────── 调参治理提案 ─────────────────────────

  /** 深梦复盘后产出调参建议。realValues = 各参数真实当前值（模型经常瞎编"现状"，一律以真实值覆盖） */
  async proposeParams(
    stats: Record<string, unknown>,
    realValues?: Record<string, number>,
  ): Promise<{ param: string; current: number; suggested: number; reason: string }[] | null> {
    const system = '你是记忆系统治理顾问。根据运行统计，最多提出 3 条数值调参建议（只调给定的数值键）。输出严格 JSON 数组（不要 markdown 代码块）：[{"param":"键","current":现值,"suggested":建议值,"reason":"一句话理由"}]。没有值得调的输出 []。'
    try {
      const out = await this.chat({ system, user: JSON.stringify(stats), maxTokens: 500, purpose: 'sandman-govern' })
      const parsed = JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] ?? '[]') as { param?: string; current?: number; suggested?: number; reason?: string }[]
      return parsed
        .filter((p) => typeof p?.param === 'string' && typeof p?.suggested === 'number')
        .slice(0, 3)
        .map((p) => ({
          param: p.param as string,
          current: realValues && typeof realValues[p.param as string] === 'number' ? realValues[p.param as string] : Number(p.current ?? 0),
          suggested: Number(p.suggested),
          reason: String(p.reason ?? ''),
        }))
    } catch {
      return null
    }
  }

  // ───────────────────────── 时效改写 / 冲突仲裁（深梦 v4）─────────────────────────

  /** 时效改写判定：这条记忆里的时间敏感表述，按当前日期与近期对话证据，是否已经过期？
   *  纪律（写死）：证据不足判 false；只改时态与状态，不增删事实；保持原文风格与信息量。
   *  返回 null = 模型不可用或输出不可信，调用方按"不改写"处理。 */
  async judgeRewrite(memory: { title: string; content: string }, evidence: string, today: string): Promise<{ outdated: boolean; newContent: string; reason: string } | null> {
    const system = [
      '你是记忆库的时光校对员。任务：判断一条记忆中的时间敏感表述是否已过期，过期则给出改写后的新文本。',
      '纪律：1) 只有近期对话证据明确表明事实已推进/完成/取消时才判 outdated=true；2) 改写只更新时态与状态，绝不增删事实、不改变原意；3) 保持原文的语言风格与信息密度；4) 拿不准一律 outdated=false。',
      '输出严格 JSON（不要 markdown 代码块）：{"outdated":true|false,"new_content":"改写后的完整新文本（false 时填空串）","reason":"一句话依据"}',
    ].join('\n')
    try {
      const out = await this.chat({
        system,
        user: `今天是 ${today}。\n\n记忆原文：\n《${memory.title}》\n${String(memory.content).slice(0, 600)}\n\n近期对话证据：\n${evidence || '（无）'}\n\n请判定。`,
        maxTokens: 700,
        purpose: 'sandman-rewrite',
      })
      const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { outdated?: boolean; new_content?: string; reason?: string }
      const outdated = parsed.outdated === true
      const newContent = String(parsed.new_content ?? '').trim()
      if (!outdated) return { outdated: false, newContent: '', reason: String(parsed.reason ?? '') }
      if (!newContent || newContent.length < 8) return null // 模型给了空/过短改写，视为不可信
      return { outdated: true, newContent, reason: String(parsed.reason ?? '') }
    } catch {
      return null
    }
  }

  /** 冲突仲裁：两条高度相似但可能矛盾的记忆，是否矛盾？矛盾时建议保留哪条？
   *  只产建议不执行——采纳/驳回走审核队列（九层之台的审核制红线）。 */
  async judgeConflict(a: { title: string; content: string }, b: { title: string; content: string }): Promise<{ contradict: boolean; suggestion: 'keep-a' | 'keep-b' | 'merge'; reason: string } | null> {
    const system = [
      '你是记忆库的仲裁员。两条记忆高度相似，判断它们是否互相矛盾（修正型记忆常见：旧偏好 vs 新偏好）。',
      '纪律：1) 只是详略不同/互为补充 = 不矛盾；2) 明确的新旧冲突（如"禁 X"与"用 X"）= 矛盾；3) 矛盾时建议保留信息更新更全的那条（keep-a/keep-b），或建议合并表述（merge）。',
      '输出严格 JSON（不要 markdown 代码块）：{"contradict":true|false,"suggestion":"keep-a|keep-b|merge","reason":"一句话"}',
    ].join('\n')
    try {
      const out = await this.chat({
        system,
        user: `记忆 A：\n《${a.title}》\n${String(a.content).slice(0, 400)}\n\n记忆 B：\n《${b.title}》\n${String(b.content).slice(0, 400)}\n\n请仲裁。`,
        maxTokens: 200,
        purpose: 'sandman-arbitrate',
      })
      const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { contradict?: boolean; suggestion?: string; reason?: string }
      const suggestion = (['keep-a', 'keep-b', 'merge'].includes(String(parsed.suggestion)) ? parsed.suggestion : 'merge') as 'keep-a' | 'keep-b' | 'merge'
      return { contradict: parsed.contradict === true, suggestion, reason: String(parsed.reason ?? '') }
    } catch {
      return null
    }
  }

  /** 检索驱动再巩固（REALM-lite）：问答用到了这些记忆 → 命中计数 +1（使用即强化）。
   *  失败静默——这步是增益不是闸门，绝不打断问答主流程。 */
  reinforce(store: Store, sources: MemoryRow[], weight = 1): void {
    try {
      for (const s of sources ?? []) store.touchAccess(String(s.id), weight)
    } catch {
      /* 静默 */
    }
  }
}

/** dsh-llm 助手：宿主有就用电报，没有就退回极简 shim（与 memory-eternal 同思路） */
async function importLlmHelpers(): Promise<{
  BlockAssembler: new () => { push(chunk: unknown): void; blocks(): { type: string; text: string }[] }
  createUserMessage: (msg: unknown) => unknown
}> {
  try {
    const mod: any = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.BlockAssembler === 'function' && typeof mod.createUserMessage === 'function') {
      return { BlockAssembler: mod.BlockAssembler, createUserMessage: mod.createUserMessage }
    }
    throw new Error('dsh-llm 导出不全')
  } catch {
    return {
      BlockAssembler: class {
        parts: string[] = []
        push(chunk: unknown) {
          const c = chunk as { text?: string; delta?: { text?: string } }
          if (typeof c?.text === 'string') this.parts.push(c.text)
          else if (typeof c?.delta?.text === 'string') this.parts.push(c.delta.text)
          else if (typeof chunk === 'string') this.parts.push(chunk)
        }
        blocks() {
          const text = this.parts.join('')
          return text ? [{ type: 'text', text }] : []
        }
      },
      createUserMessage: (msg: unknown) => msg,
    }
  }
}
