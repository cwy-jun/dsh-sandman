// ui/api.ts —— 面板与外部 API（M2-M6 全量）。
// 同一份 handler 同时适配 DSH webServer 与独立 node http（tests/serve.mjs）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Store, MemoryRow } from '../store/db.js'
import type { Dreamer, DreamAction } from '../services/dreamer.js'
import type { Curator } from '../services/curator.js'
import type { CaptureService } from '../services/capture.js'
import { parseCuratorMode, selfCheck } from '../services/curator.js'
import { takeSnapshot, listSnapshots, exportMarkdown } from '../store/snapshot.js'
import { composeInjection, DEFAULT_INJECT_OPTS } from '../services/inject.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 面板 HTML 定位：打包进 lib/、逐文件转译的 .testbuild/ui/、源码 src/ui/ 三种布局都能找见。 */
function resolvePanelHtml(): string {
  const candidates = [
    path.join(__dirname, 'panel.html'),
    path.join(__dirname, '..', 'ui', 'panel.html'),
    path.join(__dirname, '..', '..', 'src', 'ui', 'panel.html'),
    path.join(__dirname, 'src', 'ui', 'panel.html'),
  ]
  for (const p of candidates) {
    try {
      readFileSync(p, 'utf8')
      return p
    } catch {
      /* next */
    }
  }
  throw new Error(`找不到 panel.html（试过：${candidates.join(' , ')}）`)
}

export const API_PREFIX = '/dsh-sandman/api'

export interface ConfigBackend {
  get(): Record<string, unknown>
  update(patch: Record<string, unknown>): Promise<{ ok: boolean; applied?: string[]; error?: string }>
  readonly writable: boolean
}

export interface ApiDeps {
  version: string
  store: Store
  dreamer: Dreamer
  snapshotsDir: string
  configBackend: ConfigBackend
  curator?: Curator | null
  capture?: CaptureService | null
  log?: (msg: string) => void
}

export function json(res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, code: number, obj: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

export async function readJsonBody(req: { on: (ev: string, cb: (chunk?: unknown) => void) => void }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += String(chunk)
      if (data.length > 1024 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!data.trim()) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function q(reqUrl: string): URL {
  return new URL(reqUrl, 'http://localhost')
}

function parseDecisions(raw: unknown): DreamAction[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? (v as DreamAction[]) : []
  } catch {
    return []
  }
}

export function createSandmanApi(deps: ApiDeps) {
  const { version, store, dreamer, snapshotsDir, configBackend, curator, capture, log = () => {} } = deps

  const injectOpts = () => ({
    ...DEFAULT_INJECT_OPTS,
    profileBudgetMax: Number(configBackend.get().profileBudgetMax ?? 30),
    profileBudgetChars: Number(configBackend.get().profileBudgetChars ?? 200),
  })

  function overviewPayload() {
    const counts = store.counts()
    const { mode, warnings } = parseCuratorMode((configBackend.get().curator as Record<string, unknown> | undefined) ?? {})
    const plan = composeInjection(store, capture?.state.lastRoute ?? null, capture?.state.lastUserText ?? '', injectOpts())
    return {
      ok: true,
      version,
      name: '九层之台',
      now: new Date().toISOString(),
      counts,
      lock: store.dreamLockInfo(),
      curator: { mode: mode.kind, warnings, budget: curator?.budget() ?? null },
      inject: plan.stats,
      capture: capture?.stats ?? null,
    }
  }

  function cardBrief(r: MemoryRow) {
    return {
      id: r.id,
      title: r.title,
      summary: String(r.content).slice(0, 80),
      level: r.level,
      slot: r.slot,
      project_id: r.project_id,
      status: r.status,
      heat: r.heat,
      hits: r.hits ?? 0,
      importance: r.importance,
      source: r.source,
      version: r.version,
      updated_at: r.updated_at,
    }
  }

  return async function handler(req: { url?: string; method?: string }, res: { writeHead: (c: number, h: Record<string, string>) => void; end: (b: string) => void }) {
    const u = q(String(req.url ?? '/'))
    const route = u.pathname.slice(API_PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (route === '/' || route === '/health') return json(res, 200, { ok: true, name: '九层之台', version })
      if (route === '/overview') return json(res, 200, overviewPayload())

      if (route === '/cards') {
        const level = u.searchParams.get('level')
        const status = u.searchParams.get('status')
        const projectId = u.searchParams.get('project')
        const kw = u.searchParams.get('q')
        const rows = store.listMemories({
          level: level === null ? undefined : Number(level),
          status: status ?? undefined,
          projectId: projectId ?? undefined,
          q: kw ?? undefined,
          limit: 200,
        })
        return json(res, 200, { ok: true, items: rows.map(cardBrief), projects: store.listProjects() })
      }

      if (route === '/card') {
        const id = u.searchParams.get('id')
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' })
        const memory = store.getMemory(id)
        if (!memory) return json(res, 404, { ok: false, error: '记忆不存在' })
        return json(res, 200, { ok: true, memory, versions: store.listVersions(id) })
      }

      if (route === '/project') {
        const id = u.searchParams.get('id')
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' })
        const proj = store.listProjects().find((p) => p.id === id)
        if (!proj) return json(res, 404, { ok: false, error: '项目不存在' })
        const slots: Record<string, ReturnType<typeof cardBrief>[]> = { structure: [], decision: [], todo: [], ops: [], review: [] }
        for (const m of store.listMemories({ projectId: id, status: 'active', limit: 200 })) {
          const s = (m.slot && slots[m.slot] ? m.slot : 'ops') as keyof typeof slots
          slots[s].push(cardBrief(m))
        }
        for (const k of Object.keys(slots)) slots[k].sort((a, b) => b.heat - a.heat)
        return json(res, 200, { ok: true, project: proj, slots })
      }

      if (route === '/memory' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const row = store.insertMemory(
          {
            level: Number(body.level ?? 3),
            slot: (body.slot as string) ?? null,
            projectId: (body.projectId as string) ?? null,
            title: String(body.title ?? ''),
            content: String(body.content ?? ''),
            keywords: Array.isArray(body.keywords) ? (body.keywords as string[]) : [],
            status: 'active',
            source: 'manual',
          },
          'user',
          '面板手动录入',
        )
        return json(res, 200, { ok: true, id: row.id })
      }

      if (route === '/memory/edit' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const row = store.updateMemory(
          String(body.id ?? ''),
          { title: body.title !== undefined ? String(body.title) : undefined, content: body.content !== undefined ? String(body.content) : undefined },
          'user',
          '面板就地编辑',
        )
        return json(res, 200, { ok: true, id: row.id, version: row.version })
      }

      if (route === '/memory/status' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const row = store.updateMemory(String(body.id ?? ''), { status: String(body.status ?? 'active') }, 'user', String(body.note ?? '面板状态变更'))
        return json(res, 200, { ok: true, id: row.id, status: row.status, version: row.version })
      }

      if (route === '/memory/restore' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const row = store.restoreVersion(String(body.id ?? ''), Number(body.version), 'user')
        return json(res, 200, { ok: true, id: row.id, version: row.version })
      }

      // ── 变更留痕（时效改写/仲裁的 old→new 成对留底，v4）──
      if (route === '/changes') {
        return json(res, 200, { ok: true, items: store.listMemoryChanges(100) })
      }

      // ── 审核（M5）──
      if (route === '/review/pending') {
        return json(res, 200, { ok: true, items: store.listPending(200).map(cardBrief) })
      }
      if (route === '/review/failures') {
        return json(res, 200, { ok: true, items: store.recentGatingFailures(50) })
      }
      if (route === '/review/decide' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : []
        const action = String(body.action ?? '')
        const out: string[] = []
        for (const id of ids) {
          const target = store.getMemory(id)
          if (!target) continue
          if (action === 'approve') store.updateMemory(id, { status: 'active' }, 'user', '审核通过')
          else if (action === 'reject') store.updateMemory(id, { status: 'invalid' }, 'user', '审核驳回')
          else if (action === 'release') store.updateMemory(id, { status: 'pending' }, 'user', '解除隔离转人审')
          else return json(res, 400, { ok: false, error: 'action 需为 approve|reject|release' })
          out.push(id)
        }
        return json(res, 200, { ok: true, decided: out.length })
      }

      // ── 馆长提案（做梦产出的待拍板项）──
      if (route === '/signals') {
        const items: { runId: number; index: number; proposal: DreamAction; ts: number; receipt: string }[] = []
        for (const run of store.listDreamRuns(30)) {
          for (const [index, d] of parseDecisions(run.decisions).entries()) {
            if (d.type === 'proposal' && !d.resolved) {
              items.push({ runId: Number(run.id), index, proposal: d, ts: Number(run.ts), receipt: String(run.receipt ?? '') })
            }
          }
        }
        return json(res, 200, { ok: true, items: items.slice(0, 50) })
      }
      if (route === '/signals/decide' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const runId = Number(body.runId)
        const index = Number(body.index)
        const action = String(body.action ?? '')
        const run = store.getDreamRun(runId)
        if (!run) return json(res, 404, { ok: false, error: '做梦记录不存在' })
        const decisions = parseDecisions(run.decisions)
        const target = decisions[index]
        if (!target || target.type !== 'proposal') return json(res, 400, { ok: false, error: '提案不存在' })
        if (action === 'adopt') {
          if (target.action === 'param' && target.param) {
            const out = await configBackend.update({ [target.param]: target.suggested })
            if (!out.ok) return json(res, 400, out)
          } else if (target.action === 'assign' && target.target) {
            store.updateMemory(target.target, { level: 1, slot: 'ops' }, 'curator', '提案采纳：归入项目')
          } else if (target.action === 'promote' && target.target) {
            const toLevel = Number(target.toLevel ?? 2)
            const toSlot = String(target.toSlot ?? 'knowledge')
            store.updateMemory(target.target, { level: toLevel, slot: toSlot }, 'curator', `提案采纳：晋升为层级 ${toLevel}/${toSlot}`)
          } else if (target.action === 'resolve' && target.target && target.why) {
            // 冲突仲裁采纳：保留赢家，输家归档（不物理删除）；merge = 保留 A 并提示人工合并表述
            const winnerId = target.suggestion === 'keep-b' ? target.why : target.target
            const loserId = target.suggestion === 'keep-b' ? target.target : target.why
            const loser = store.getMemory(loserId)
            if (loser) {
              store.updateMemory(loserId, { status: 'archived' }, 'curator', `冲突仲裁采纳：保留「${store.getMemory(winnerId)?.title ?? winnerId}」`)
              store.recordMemoryChange({
                memoryId: loserId,
                changeType: 'arbitrate',
                oldContent: String(loser.content ?? ''),
                newContent: null,
                reason: `仲裁输家归档，保留 ${winnerId}`,
                dreamRunId: runId,
              })
            }
          }
          target.resolved = true
          target.note = '已采纳'
        } else if (action === 'reject') {
          target.resolved = true
          target.note = '已驳回'
        } else {
          return json(res, 400, { ok: false, error: 'action 需为 adopt|reject' })
        }
        store.updateDreamRunDecisions(runId, decisions)
        return json(res, 200, { ok: true, action })
      }

      // ── 馆长问答（M6）──
      if (route === '/curator/ask' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const question = String(body.q ?? '').trim()
        if (!question) return json(res, 400, { ok: false, error: '缺少 q' })
        if (!curator) return json(res, 501, { ok: false, error: '馆长未装配' })
        // 带上持久化历史（切会话/重载面板不丢）+ 项目对话摘录（馆长能看见聊了什么）
        const history = store.listCuratorChat(20).map((r) => ({ role: String(r.role), content: String(r.content) }))
        const dialogueRows = store.listSessionLog({ projectId: body.projectId ? String(body.projectId) : undefined, limit: 12 })
        const dialogue = dialogueRows.length
          ? dialogueRows.map((r) => `${r.role === 'user' ? '用户' : '助手'}：${String(r.content).slice(0, 160)}`).join('\n')
          : ''
        const out = await curator.ask(store, question, history, dialogue)
        store.appendCuratorChat('user', question)
        store.appendCuratorChat('curator', out.answer, out.sources.map((s) => ({ id: s.id, title: String(s.title) })))
        return json(res, 200, { ok: true, ...out, sources: out.sources.map(cardBrief) })
      }
      // ── 项目对话（馆长可见，v3）──
      if (route === '/curator/sessions') {
        const u = new URL(req.url ?? '', 'http://x')
        const projectId = u.searchParams.get('projectId') ?? undefined
        const limit = Number(u.searchParams.get('limit') ?? 60)
        return json(res, 200, { ok: true, items: store.listSessionLog({ projectId: projectId || undefined, limit }) })
      }
      // ── 馆长对话持久化（v3）──
      if (route === '/curator/chat') {
        return json(res, 200, { ok: true, items: store.listCuratorChat(200) })
      }
      if (route === '/curator/chat/clear' && method === 'POST') {
        return json(res, 200, { ok: true, cleared: store.clearCuratorChat() })
      }
      if (route === '/curator/selfcheck') {
        const raw = (configBackend.get().curator as Record<string, unknown> | undefined) ?? {}
        const { mode, warnings } = parseCuratorMode(raw)
        const check = await selfCheck(mode)
        return json(res, 200, { ok: check.ok, check, warnings, budget: curator?.budget() ?? null })
      }

      // ── 个性化：全局指令 + 按工作区指令（v3）──
      if (route === '/persona' && method === 'GET') {
        return json(res, 200, { ok: true, items: store.listPersonalization(false) })
      }
      if (route === '/persona' && method === 'POST') {
        const body = await readJsonBody(req as never)
        // 仅开关（不带 content）：{id, enabled} —— 用于启用/停用已有指令
        if (body.id && body.content === undefined) {
          const cur = store.listPersonalization(false).find((i) => i.id === String(body.id))
          if (!cur) return json(res, 404, { ok: false, error: '指令不存在' })
          const row = store.upsertPersonalization({
            id: String(cur.id), scope: String(cur.scope), workspace: (cur.workspace as string) ?? null,
            match: (cur.match as string) ?? null, content: String(cur.content), enabled: body.enabled !== false,
          })
          return json(res, 200, { ok: true, item: row })
        }
        const content = String(body.content ?? '').trim()
        if (!content) return json(res, 400, { ok: false, error: '缺少 content' })
        const scope = body.scope === 'workspace' ? 'workspace' : 'global'
        if (scope === 'workspace' && !String(body.match ?? body.workspace ?? '').trim()) {
          return json(res, 400, { ok: false, error: '工作区指令需要 match 命中关键词（或工作区名）' })
        }
        const row = store.upsertPersonalization({
          id: body.id ? String(body.id) : undefined,
          scope,
          workspace: body.workspace ? String(body.workspace) : null,
          match: body.match ? String(body.match) : null,
          content,
          enabled: body.enabled !== false,
        })
        return json(res, 200, { ok: true, item: row })
      }
      if (route === '/persona/delete' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const ok = store.deletePersonalization(String(body.id ?? ''))
        return json(res, ok ? 200 : 404, { ok, id: String(body.id ?? '') })
      }

      // ── 梦境（M4）──
      if (route === '/dream/status') {
        return json(res, 200, {
          ok: true,
          schedule: {
            lightEveryTurns: Number(configBackend.get().lightEveryTurns ?? 8),
            deepIdleMinutes: Number(configBackend.get().deepIdleMinutes ?? 30),
            peakSuppress: configBackend.get().peakSuppress !== false,
          },
          lock: store.dreamLockInfo(),
          runs: store.listDreamRuns(5),
        })
      }
      if (route === '/dream/runs') {
        const items = store.listDreamRuns(100).map((r) => ({ ...r, decisions: parseDecisions(r.decisions) }))
        return json(res, 200, { ok: true, items })
      }
      if (route === '/dream/run' && method === 'POST') {
        const body = await readJsonBody(req as never)
        const kind = (['light', 'deep', 'manual'].includes(String(body.kind)) ? body.kind : 'manual') as 'light' | 'deep' | 'manual'
        const run = await dreamer.run(kind)
        if (!run) return json(res, 409, { ok: false, error: '已有做梦在跑（或锁被其它窗口持有）' })
        return json(res, 200, { ok: true, run })
      }
      if (route === '/dreams-journal') {
        return json(res, 200, { ok: true, md: dreamer.readDreamsJournal() })
      }

      // ── 可解释：最近路由判定 ──
      if (route === '/route/recent') {
        return json(res, 200, { ok: true, items: store.recentRoutes(50) })
      }

      // ── 调试：检索链路自检（查"明明有却搜不到"时先看这里）──
      if (route === '/debug/search') {
        const kw = u.searchParams.get('q') ?? ''
        const tokens = (await import('../core/bm25.js')).tokenize(kw)
        const fts = (await import('../core/bm25.js')).toFtsText(kw)
        return json(res, 200, {
          ok: true,
          q: kw,
          tokens,
          ftsText: fts,
          searchCards: store.searchCards(kw, 6).map((m) => m.title),
          listActive: store.listMemories({ q: kw, status: 'active', limit: 6 }).map((m) => m.title),
        })
      }

      // ── 配置 / 快照 / 导出 ──
      if (route === '/config') {
        if (method === 'GET') return json(res, 200, { ok: true, config: configBackend.get(), writable: configBackend.writable })
        if (method === 'POST') {
          const body = await readJsonBody(req as never)
          const out = await configBackend.update((body.patch as Record<string, unknown>) ?? {})
          return json(res, out.ok ? 200 : 400, out)
        }
        return json(res, 405, { ok: false, error: '只支持 GET/POST' })
      }
      if (route === '/snapshot' && method === 'POST') {
        const s = takeSnapshot(store, snapshotsDir)
        return json(res, 200, { ok: true, id: s.id, manifest: s.manifest })
      }
      if (route === '/snapshots') {
        return json(res, 200, { ok: true, items: listSnapshots(snapshotsDir) })
      }
      if (route === '/export' && method === 'POST') {
        const dest = path.join(snapshotsDir, 'export-md')
        const out = exportMarkdown(store.vaultDir, dest)
        return json(res, 200, { ok: true, dest, ...out })
      }
      if (route === '/inject/preview') {
        return json(res, 200, {
          ok: true,
          plan: composeInjection(store, capture?.state.lastRoute ?? null, capture?.state.lastUserText ?? '', injectOpts()),
        })
      }
      if (route === '/ui/panel') {
        const html = readFileSync(resolvePanelHtml(), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(html)
      }
      return json(res, 404, { ok: false, error: `未知路由 ${route}` })
    } catch (error) {
      log(`API 失败 ${route}：${String((error as Error)?.stack ?? error)}`)
      return json(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    }
  }
}
