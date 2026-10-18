# LLM 认证路径验证报告

**日期**: 2026-08-08
**目标**: 验证 agent-runtime 的 deepseek-v4-flash LLM 认证路径是否工作
**结论**: ✅ **认证路径本身完全可用** —— env-var fallback 正常，真实 LLM 调用成功返回。
⚠️ 但发现 **dist 构建产物过期**（独立问题，见下方「需注意」）。

---

## 验收结果

| 验收项 | 状态 | 证据 |
|--------|------|------|
| `resolveRoleModel()` 返回 `deepseek-v4-flash` | ✅ | fast tier → `deepseek:deepseek-v4-flash`；balanced/deep → `deepseek:deepseek-v4-pro` |
| `session.prompt("say hello")` 不抛认证错误 | ✅ | 返回真实 LLM 响应 `"Hello! 👋"`，无 auth error |
| 认证路径文档化 | ✅ | 见下方 |

---

## 认证路径（已确认生效）

```
.env (DEEPSEEK_API_KEY=sk-...)
  │
  │  scripts/start.sh 第 144-153 行: `set -a; source .env`
  │  （注释明确写道：plain `node dist/index.js` 从不自己读 .env）
  ▼
sidecar 进程 process.env.DEEPSEEK_API_KEY
  │
  │  createDefaultPiSessionProvider() (session-manager.ts:442)
  │  → ModelRuntime.create({ authPath: ~/.pi/agent/auth.json,
  │                         modelsPath: ~/.pi/agent/models.json })
  ▼
ModelRuntime.create() (pi-coding-agent model-runtime.js:57-87)
  │  credentials = RuntimeCredentials(AuthStorage(auth.json))
  │  auth.json = {} (空存储) → deepseek 无 stored credential
  │  → 回退到 provider auth resolution
  │  models.json 不存在 → ModelConfig.load() 优雅降级为空配置
  │  注册全部 builtin providers（含 deepseek）
  ▼
pi-ai env-api-keys.js:75  →  deepseek provider 的 env var = "DEEPSEEK_API_KEY"
  │  findEnvKeys("deepseek") → process.env.DEEPSEEK_API_KEY 命中
  │  checkAuth("deepseek") → { source: "DEEPSEEK_API_KEY", type: "api_key" } ✅
  ▼
getAvailable("deepseek") → 2 个模型可用:
  - deepseek-v4-flash  (api=openai-completions)
  - deepseek-v4-pro    (api=openai-completions)
  │
  │  resolveRoleModel() (model-routing.ts:51-63)
  │  getAvailable() 凭证校验通过 → 返回具体 Model
  ▼
createAgentSession({ model }) → session.prompt() → DeepSeek API → 响应 ✅
```

### 关键确认点

1. **空 auth.json 不阻塞**：`~/.pi/agent/auth.json` 内容为 `{}`（空对象），pi-ai 的
   `CredentialStore` 把它视为「无 stored credential」，按设计回退到环境变量。
   （pi-ai README：「environment variables are only consulted when nothing is stored」）

2. **缺失 models.json 不阻塞**：`~/.pi/agent/models.json` 不存在，
   `ModelConfig.load()` 优雅降级为空配置；builtin providers（含 deepseek）仍正常注册。

3. **env var 是唯一生效路径**：此环境下没有任何 file-based 凭证，认证完全依赖
   `DEEPSEEK_API_KEY` 环境变量，由 `scripts/start.sh` 的 `set -a; source .env` 注入。

---

## 实测输出（节选）

```
=== 5. checkAuth('deepseek') ===
deepseek auth: { "source": "DEEPSEEK_API_KEY", "type": "api_key" }

=== 6. getAvailable('deepseek') ===
deepseek available models: 2
  - deepseek-v4-flash  (api=openai-completions)
  - deepseek-v4-pro    (api=openai-completions)

=== 7. resolveRoleModel() for each tier ===
  fast:      OK -> deepseek:deepseek-v4-flash
  balanced:  OK -> deepseek:deepseek-v4-pro
  deep:      OK -> deepseek:deepseek-v4-pro

=== 9. LIVE PROMPT ===
message count after prompt: 2
  [user]      say hello in one short sentence
  [assistant] Hello! 👋
```

测试方法：用 `tsx` 从源码（非 dist）运行最小脚本，复现
`createDefaultPiSessionProvider()` 的 `ModelRuntime.create()` + `resolveRoleModel()`
+ `createAgentSession()` + `session.prompt()` 全链路。脚本未修改任何生产代码，
运行后已删除。

---

## ⚠️ 需注意的问题（认证本身可用，但影响实际运行）

### 问题 1：dist 构建产物过期（P0，阻塞实际 sidecar 运行）

`agent-runtime/dist/` 是**过期**的——它早于 `modelClassRouting` /
`model-routing.ts` 特性的引入：

- `dist/config.js`（46 行）**没有** `modelClassRouting` 字段；
  源码 `src/config.ts`（122 行）有。
- `dist/roles/` **没有** `model-routing.js`；源码 `src/roles/model-routing.ts` 有。
- `dist/roles/session-manager.js` **不引用** `modelRouting`/`resolveRoleModel`
  /`modelClassRouting`（0 处匹配）。

**影响**：实际生产入口 `node dist/index.js` 使用的 `defaultConfig.modelClassRouting`
会是 `undefined`，首个 session 创建时会 crash（`resolveRoleModel` 收到 `routing=undefined`
→ `routing[modelClass]` TypeError）。

**修复**：在 sidecar 启动前重新构建 dist——
```bash
cd agent-runtime && npm run build   # 或 npx tsc -p tsconfig.json
```
`scripts/start.sh` 目前**不自动构建**（仅在 dist 缺失时构建；dist 存在但过期时直接复用）。

### 问题 2：CONTEXT.md 与实际默认值不符（文档准确性）

`CONTEXT.md` 称「所有角色统一使用 deepseek-v4-flash（不分 tier），通过把
`AGENT_RUNTIME_MODEL_FAST/BALANCED/DEEP` 三个环境变量都设为
`deepseek:deepseek-v4-flash` 实现」。

**实际**：`.env` 中**没有**这三个环境变量（实测 `<unset>`），因此走
`config.ts` 的代码默认值：
- `fast` → `deepseek-v4-flash`
- `balanced` → `deepseek-v4-pro`
- `deep` → `deepseek-v4-pro`

即 balanced/deep 实际用的是 `deepseek-v4-pro`，并非 CONTEXT.md 所述的统一 flash。

**修复选项**（二选一）：
- 在 `.env` 加入三行 `AGENT_RUNTIME_MODEL_FAST/BALANCED/DEEP=deepseek:deepseek-v4-flash`，
  使实际行为与 CONTEXT.md 一致；或
- 更新 CONTEXT.md 以反映代码默认值（fast=flash，balanced/deep=pro）。

---

## 不需要的修复

认证路径本身**无需任何修复**。以下均确认正常工作：
- 空 `auth.json`（`{}`）→ env var fallback
- 缺失 `models.json` → 优雅降级
- `DEEPSEEK_API_KEY` env var 注入（经 start.sh 的 `source .env`）
- deepseek provider auth resolution
- `resolveRoleModel()` 凭证校验
- 真实 LLM API 调用

无需创建新的 auth.json、models.json 或新的认证路径。
