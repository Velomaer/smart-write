# smart-write

防御性 Tool（Smart Edit）+ 自动反思沉淀（Memory）的 MCP Harness。
用于解决 AI 对话编码在**长上下文**下常见的两类写入事故：

- **覆盖冲突**：基于过期快照做全量写入，把磁盘上别人（格式化进程 / 其他 agent）的改动盖掉。
- **重复残留**：锚点找不到就退化成"追加到末尾"，导致同一个方法 / 类被写两遍（"磁盘竟有 160 行且含大量重复残留"）。

核心思路：把"盲写"换成"带前置校验的增量写"，并把每次被拒绝的失败沉淀成长期规则，下次开局注入。

---

## 三个工具

| 工具 | 作用 | 防御机制 |
|---|---|---|
| `read_file` | 读文件并登记内容指纹 | M1 读后写 |
| `smart_edit` | 定点替换，写前 CAS 校验、锚点唯一、幂等，写后回读自检、原子写；支持 `preview` 干跑出 diff | M2/M3/M4/M5/M6 |
| `remember_failure` | 把一次失败归纳成规则写入 `memory/`（带查重） | 右半环 |

`smart_edit` 的返回是**结构化信号**，直接决定下一步：

- `OK ...` / `OK[NoOp] ...` —— 成功或幂等跳过。
- `PREVIEW ...` —— `preview=true` 干跑：已通过全部校验，返回 diff 但未写盘。→ 给用户看 diff，确认后用相同 old/new 以 `preview=false` 写入。
- `ERR[Unread]` —— 没先 `read_file`。→ 先读。
- `ERR[Stale]` —— 磁盘指纹与上次读取不符（被格式化/他人改动）。→ 重新 `read_file` 再改。
- `ERR[NotFound]` —— old 锚点不存在（旧版本/幻觉）。→ 重新 `read_file`，别硬写。
- `ERR[Ambiguous]` —— old 出现多次，盲替会重复。→ 给 old 补上下文使其唯一。
- `WARN[Duplicate]` —— 写入成功但检测到同名方法/类/import 出现 ≥2 次。→ 人工确认是否回滚。

---

## 安装

```bash
cd smart-write
npm install
npm run typecheck   # 可选：类型检查
npm run build       # 产出 dist/server.js
```

开发期免构建直接跑：`npm run dev`（用 tsx 执行 `src/server.ts`）。

---

## 在 joycode 注册 MCP server

在 joycode 的 MCP 配置里加一项（字段名以 joycode 实际界面为准，形态如下）。

生产（先 `npm run build`）：

```json
{
  "mcpServers": {
    "smart-write": {
      "command": "node",
      "args": ["/Users/wangxiaoyu.331/mcp/smart-write/dist/server.js"]
    }
  }
}
```

开发（免构建，需本机有 npx/tsx）：

```json
{
  "mcpServers": {
    "smart-write": {
      "command": "npx",
      "args": ["tsx", "/Users/wangxiaoyu.331/mcp/smart-write/src/server.ts"]
    }
  }
}
```

重启 joycode 后，工具列表里应出现 `read_file` / `smart_edit` / `remember_failure`。

---

## 把新工具变成"唯一合法写入路径"

光有工具不够，必须禁掉内置全量写。把下面这段粘进 **joycode 的规则 / 团队规范文件**：

```markdown
# 编辑纪律（强制）
1. 禁止使用内置全量文件写入/覆盖。所有文件修改必须走 smart_edit 工具。
2. 编辑任何文件前，必须先用 read_file 读取它（否则 smart_edit 会返回 ERR[Unread]）。
3. 两步写入：先以 preview=true 调 smart_edit 拿到 diff，展示给用户；用户确认后，再用**相同的 old/new** 以 preview=false 实际写入。未经确认不得直接写入。
4. smart_edit 返回 ERR[...] 时：不得原样重试，必须按错误提示行动——
   - ERR[Stale]/ERR[NotFound] → 重新 read_file 再改；
   - ERR[Ambiguous] → 给 old 补充上下文使其唯一。
5. 当同一文件累计 ≥2 次 ERR，或任务收尾时，调用 remember_failure 归纳规则。
6. 每次新会话开局，先读取 /Users/wangxiaoyu.331/mcp/smart-write/memory/INDEX.md（或读取 MCP 资源 smartwrite://rules），遵守其中已沉淀的规则。
```

---

## 闭环如何咬合（试错成本 → 长期记忆）

1. 模型基于旧快照想改某文件；
2. `smart_edit` 发现磁盘指纹不符 → `ERR[Stale]`，**写坏被拦下**；
3. 规则要求重新 `read_file` 再改 → 成功；
4. 同类 Stale 第 2 次 → `remember_failure(...)` 归纳成规则；
5. 下次开局读 `INDEX.md`，模型开局就知道该文件要先重读 → 同类错误不再发生。

---

## 说明与边界

- `read_registry` 是**进程内内存**，joycode 重启即清空——这是有意的，它只在单次会话内有效；跨会话的持久知识全部沉淀在 `memory/`。
- `duplicateScan` 的 Java 正则是够用的**近似版**，能拦住"整个方法被写两遍"这类典型残留；要严谨可换成基于 AST 的检测。
- `smart_edit` 只做**单点唯一替换**，不支持一次多处替换（多处请多次调用，每次锚点唯一），这正是防重复的代价与保证。