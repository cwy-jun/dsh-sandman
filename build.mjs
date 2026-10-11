// 九层之台（dsh-sandman）构建脚本。两种产物：
//  1) lib/index.js —— esbuild 单文件包（@deepseek-ai/* 外置、schemastery 内联），装进 DSH profile 用；
//     同时把 ui/panel.html 拷到 lib/（api.ts 在运行时按候选路径找它）。
//  2) .testbuild/ —— src 逐文件转译（不打包），供 node --test / seed / serve 直接 import。
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

// 1) DSH 单文件包
const bundled = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})
if (bundled.errors.length) process.exit(1)
mkdirSync('lib', { recursive: true })
copyFileSync('src/ui/panel.html', 'lib/panel.html')
copyFileSync('src/client.js', 'lib/client.js')

// 2) 测试用逐文件转译
const transpiled = await build({
  entryPoints: [
    'src/core/schema.ts', 'src/core/heat.ts', 'src/core/bm25.ts', 'src/core/gating.ts', 'src/core/router.ts',
    'src/store/db.ts', 'src/store/mirror.ts', 'src/store/snapshot.ts',
    'src/services/capture.ts', 'src/services/dreamer.ts', 'src/services/curator.ts', 'src/services/inject.ts',
    'src/ui/api.ts',
  ],
  outdir: '.testbuild',
  outbase: 'src',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
})
if (transpiled.errors.length) process.exit(1)
mkdirSync('.testbuild/ui', { recursive: true })
copyFileSync('src/ui/panel.html', '.testbuild/ui/panel.html')

console.log(`build ok: ${path.join(root, 'lib')} + .testbuild`)
