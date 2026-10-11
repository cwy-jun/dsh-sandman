// 复算 dshmarket 更新前试运行的组合校验：社区 bundle 层 + profile 补丁层
// 确认无 duplicate loader entry id（插件市场"更新全回滚"的根因排查工具）
// 用法：DSHMARKET_LIB=<dshmarket/lib/check.js 路径> PROFILE_DIR=<profile 目录> DSH_HOME=<DSH 家目录> node scripts/verify-market-composition.mjs
//   默认值是典型布局，指向你自己的安装时建议显式传环境变量。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DSHMARKET_LIB = process.env.DSHMARKET_LIB ?? 'D:/28384/dsh-home/profiles/desktop/node_modules/dshmarket/lib/check.js';
const profileDir = process.env.PROFILE_DIR ?? 'D:/28384/dsh-home/profiles/desktop';
const dshHome = process.env.DSH_HOME ?? 'D:/28384/dsh-home';
const { composeLayers, parsePatchFile } = await import('file:///' + DSHMARKET_LIB.replace(/\\/g, '/'));
const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const bundles = pkg.dsh.profile.bundles;

const layers = [];
for (const name of bundles) {
  if (name.startsWith('@deepseek-ai/')) continue; // 宿主私有，profile 侧不可解析
  const dir = join(profileDir, 'node_modules', ...name.split('/'));
  const patchPath = join(dir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) continue;
  const patches = parsePatchFile(patchPath);
  if (!patches) { console.log(`[跳过] ${name} 补丁解析失败`); continue; }
  layers.push({ label: name, patches });
}
const profPatch = join(profileDir, 'cordis.patch.yml');
if (existsSync(profPatch)) {
  const patches = parsePatchFile(profPatch);
  if (patches) layers.push({ label: 'profile-patch', patches });
}
const homePatch = join(dshHome, 'cordis.patch.yml');
console.log('home overlay 是否已移除:', !existsSync(homePatch));
console.log('参与组合的层:', layers.map(l => l.label).join(' | '));

const composed = composeLayers(layers);
console.log('duplicates:', composed.duplicates.length ? JSON.stringify(composed.duplicates, null, 2) : '无 ✅');
console.log('orphans:', composed.orphans.length ? JSON.stringify(composed.orphans, null, 2) : '无');
console.log('总行数:', composed.rows.length);
const gf = composed.rows.filter(r => r.id === 'mcp-graphflow' || r.id === 'graphflow-dsh');
console.log('graphflow 相关行:', JSON.stringify(gf.map(r => ({ id: r.id, layer: r.layer }))));
