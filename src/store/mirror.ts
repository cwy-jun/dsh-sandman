// store/mirror.ts —— Markdown 镜像：SQLite 是唯一事实源，这里是给人看的投影。
// 人能直接用任意编辑器打开 vaultDir 看/改（与 DSH 记忆核心的知识卡同一哲学）。
// 写文件一律 node:fs（UTF-8 无 BOM）；绝不用 PowerShell 管道（中文乱码不可逆）。
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import path from 'node:path'

const LEVEL_DIRS: Record<number, string> = {
  0: '画像',
  1: '项目',
  2: '文库',
  3: '底档',
}

export interface MirrorMemory {
  id: string
  level: number
  slot: string | null
  project_id: string | null
  title: string
  content: string
  keywords: string // JSON 数组串
  status: string
  heat: number
  importance: number
  source: string
  version: number
  created_at: number
  updated_at: number
  project_name?: string | null
}

/** 文件名清洗：Windows 非法字符替换 + 长度封顶 */
export function sanitizeFilename(name: string, max = 80): string {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\r\n]+/g, '-').trim()
  return (cleaned || '未命名').slice(0, max)
}

/** 镜像相对路径：<层目录>[/<项目名>]/<槽位-><标题>.md */
export function mirrorRelPath(m: MirrorMemory): string {
  const title = sanitizeFilename(m.title)
  const slot = m.slot ? `${m.slot}-` : ''
  const base = `${slot}${title}.md`
  const dir = LEVEL_DIRS[m.level] ?? '底档'
  if (m.level === 1 && m.project_name && m.project_name !== 'global') {
    return path.join(dir, sanitizeFilename(m.project_name, 40), base)
  }
  return path.join(dir, base)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function frontmatter(m: MirrorMemory): string {
  const kw = safeArr(m.keywords)
  const lines = [
    '---',
    `id: ${m.id}`,
    `level: ${m.level}`,
    ...(m.slot ? [`slot: ${m.slot}`] : []),
    `project: ${m.project_id ?? ''}`,
    `status: ${m.status}`,
    `heat: ${m.heat}`,
    `importance: ${m.importance}`,
    `source: ${m.source}`,
    `version: ${m.version}`,
    `created: ${iso(m.created_at)}`,
    `updated: ${iso(m.updated_at)}`,
    `keywords: ${JSON.stringify(kw)}`,
    '---',
  ]
  return lines.join('\n')
}

/** 双写：覆盖写镜像文件；已有文件先留 .bak（可还原）。返回写入的绝对路径。 */
export function writeMirror(vaultDir: string, m: MirrorMemory): string {
  const rel = mirrorRelPath(m)
  const abs = path.join(vaultDir, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  if (existsSync(abs)) {
    try {
      copyFileSync(abs, abs + '.bak')
    } catch {
      /* .bak 失败不阻断主流程 */
    }
  }
  const body = `${frontmatter(m)}\n\n# ${m.title}\n\n${m.content}\n`
  writeFileSync(abs, body, { encoding: 'utf8' })
  return abs
}

/** 读镜像文件正文（调试/对账用） */
export function readMirror(vaultDir: string, rel: string): string | null {
  const abs = path.join(vaultDir, rel)
  if (!existsSync(abs)) return null
  return readFileSync(abs, 'utf8')
}

function safeArr(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
