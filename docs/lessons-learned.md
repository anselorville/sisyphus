# 经验记忆：调试教训

> 本文件记录项目开发中踩过的坑和沉淀的经验。每条按「症状 → 排查 → 根因 → 规则」记录，
> 防止同一类错误再次发生。新增条目时保持格式一致。

---

## 2026-08-09：旧进程未死导致"修复不生效"的调试幻觉

### 症状

用户报告语音播报重复（同一句回答播两遍），修改了 sidecar 的断句与去重逻辑后，
多次构建、重启、测试，**日志显示的行为始终是旧代码的行为**：
- `PiEventAdapter` 的句子感知切分没生效（还是整段合并）
- `emitTerminal` 的去重日志（`skipSpeech`）从未出现在 sidecar 日志里
- 但 dist 文件确实包含了新代码（`grep` 确认）

### 排查过程

1. 反复改代码 → `npm run build` → `pkill -f "agent-runtime/dist/index.js"` → 重启 → 测试
2. 每次测试结果一致：旧行为
3. 加更多日志 → 仍然看不到新日志
4. 最终用 `lsof -i :8765` 检查端口：**监听进程 PID 是 26441，而自己刚启动的是 39239**
5. `ps aux | grep agent-runtime/dist` 显示 **26441 还活着**——它才是真正服务请求的进程
6. 杀掉 26441 后，新代码立即生效，重复问题消失

### 根因

- `pkill -f "agent-runtime/dist/index.js"` **没有匹配到实际进程**（PID 26441）
- 新进程 39239 启动时端口被占 → **静默退出**（nohup 把启动错误吞了，没有报错）
- 后续所有测试请求都由旧进程 26441 处理 → 永远看到旧行为
- 我**从未验证**「旧进程确实被杀掉」「新进程确实在监听端口」这两个前置条件
- 时间线：反复重启了 5+ 轮，每一轮都在调试一个根本不存在的"新代码 bug"

### 规则（防再犯）

1. **改代码后必须验证"运行中的就是新代码"**，三连确认：
   ```bash
   # 1) 杀进程后验证端口已释放
   lsof -i :8765 || echo "PORT FREE"
   # 2) 启动后验证新 PID 确实在监听
   lsof -i :8765 | grep LISTEN
   # 3) 新代码的标志性日志出现（如 grep 刚加的日志串）
   grep "新加的日志关键词" /tmp/sisyphus-sidecar.log
   ```
2. **pkill 不可靠**——进程可能因路径/参数差异匹配不到。杀进程用
   `lsof -ti :<port> | xargs kill -9`（按端口杀），或 start.sh 的 `kill_port`。
3. **nohup 启动会吞掉启动错误**——启动后必须确认进程活着
   （`ps -p <pid>` 或 `lsof -i :<port>`），不能只看 "PID=$!" 输出。
4. **日志是真理**：如果加了日志但日志里没有，第一反应应该是
   "我测的是不是这个进程？"，而不是继续加日志。
5. 调试 `scripts/start.sh` 管不到的手动进程时，优先用 start.sh
   （它内置 `kill_port` 双保险），而不是裸 pkill。

### 相关文件

- `agent-runtime/src/roles/pi-event-adapter.ts` — 句子感知切分（本次修复对象之一）
- `agent-runtime/src/tasks/task-executor.ts` — emitTerminal 去重（本次修复对象之二）
- `scripts/start.sh` — 官方启停脚本（内置端口级 kill）
