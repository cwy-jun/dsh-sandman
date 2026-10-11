// store/snapshot.ts —— 快照 / 导出 / 恢复清单。
// 纪律（交接文档血泪）：快照前做 WAL 检查点；备份一律 db+wal+shm 三件一起。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Store } from './db.js'

/** 做一次快照：checkpoint → 拷三件 → manifest.json。返回快照目录名。 */
export function takeSnapshot(store: Store, snapshotsDir: string): { id: string; dir: string; manifest: Record<string, unknown> } {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const dir = path.join(snapshotsDir, id)
  mkdirSync(dir, { recursive: true })
  const copied = store.backupFiles(dir)
  const counts = store.counts()
  const schema = store.db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }
  const manifest = {
    id,
    created_at: d.toISOString(),
    schema_version: schema?.v ?? 1,
    counts,
    files: copied,
    input_hash_note: 'input_hash 口径 = 快照输入集合的 sha256；M4 做梦执行体接入后逐轮计算',
  }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { id, dir, manifest }
}

export interface SnapshotInfo {
  id: string
  manifest: Record<string, unknown> | null
}

/** 列出现有快照（按目录名倒序） */
export function listSnapshots(snapshotsDir: string): SnapshotInfo[] {
  if (!existsSync(snapshotsDir)) return []
  const out: SnapshotInfo[] = []
  for (const name of readdirSync(snapshotsDir)) {
    const dir = path.join(snapshotsDir, name)
    if (!statSync(dir).isDirectory()) continue
    let manifest: Record<string, unknown> | null = null
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    } catch {
      /* 无 manifest 的目录也列出 */
    }
    out.push({ id: name, manifest })
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1))
}

/** 一键导出 Markdown 镜像（人能带走的形态） */
export function exportMarkdown(vaultDir: string, destDir: string): { files: number } {
  mkdirSync(destDir, { recursive: true })
  cpSync(vaultDir, destDir, { recursive: true })
  let files = 0
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.md')) files++
    }
  }
  walk(destDir)
  return { files }
}
