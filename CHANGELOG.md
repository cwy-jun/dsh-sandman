# CHANGELOG

> **预览版 · 娱乐性项目。** 本仓库是个人实验作品，不是生产级工具：schema 与接口可能随时变更，升级不保证向后兼容，请勿用于重要数据。
> 版本号的语义仅供参考，不代表稳定性承诺。

## v1.0.0 · 2026-10-11（Preview）

首个公开版本 —— 标记为 **Preview**。M1–M6 全量 + v4 机制升级。

### 新增
- **时效改写**：深梦扫描时间敏感表述（推进中/下周/截止…），馆长对照当前日期与近期对话证据判过期，自动改写，旧文成对留痕（`memory_changes` 表 + 审核页「改写留痕」diff 视图）。
- **冲突仲裁**：同层相似度 0.5–0.9 的疑似矛盾对送馆长判定，只产提案不执行；采纳后输家归档并留痕（审核制红线）。
- **显著性地板**：画像层（level 0）不再进入冷化候选——过期事实走改写，不走遗忘。
- **检索驱动再巩固**：馆长问答引用到的记忆命中 +1（使用即强化，REALM-lite）。
- **审核页「改写留痕」标签页**：`#/review?tab=2` 深链接直达，old→new 删除线对照。
- **UI 重设计**：现代主义中式（宣纸 · 墨 · 朱砂）——宋体标题、零圆角细线、印章标识。

### 修复
- 插件市场"更新全回滚"排查工具 `scripts/verify-market-composition.mjs`（复算 dshmarket trial validation 的组合校验）。
- `staleCandidates` 误伤画像层（地板保护）。
- 测试脚本补齐 curator-dialogue / persona-chat / m4-v4 用例，迁移断言随 v4 更新。

### 工程
- schema v4（`m4-memory-changes`）；57/57 测试绿；`typecheck` 零错。
- 开源整理：MIT LICENSE、README（中英）、CHANGELOG、SECURITY、`.gitignore`（含个人数据脚本隔离）、合成演示数据与截图流水线（`scripts/make-demo-db.mjs` + `preview-panel.mjs`）。

## v0.x · 2026-10-10 及之前（内部开发）

- M1 框架（schema v1 + 迁移链 + 面板壳）、M2 写门（三道门 + 投毒隔离）、M3 路由（项目判定 + 契合度过滤 + 注入）、M4 三档做梦（锁 + 收据 + DREAMS.md）、M5 面板全量、M6 馆长三模式。
- schema v2（hits 列）、v3（馆长对话持久化 + 个性化指令 + 项目对话流水）。
