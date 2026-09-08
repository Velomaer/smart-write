# smart-write

防御性 Tool（Smart Edit）+ 自动反思沉淀（Memory）的 **MCP Server**。
用于解决 AI 对话编码在**长上下文**下常见的两类写入事故：

- **覆盖冲突**：基于过期快照做全量写入，把磁盘上别人（格式化进程 / 其他 agent）的改动盖掉。
- **重复残留**：锚点找不到就退化成"追加到末尾"，导致同一个方法 / 类被写两遍（"磁盘竟有 160 行且含大量重复残留"）。

核心思路：把"盲写"换成**带前置校验的增量写**，并把每次被拒绝的失败**沉淀成长期规则**，下次开局注入 —— 同类错误不再犯。

---

## 它是怎么工作的

一句话：**把 AI 的"内置全量写"替换为唯一合法的防御性增量写入路径，并让每次写入事故都转化为下次不再犯的长期记忆。**

```
read_file ──登记指纹──► smart_edit ──六道校验──► 写盘
                            │
                        失败被拦下（ERR/WARN）
                            │
                     remember_failure ──归纳──► memory/rules/{global,scoped}/*.json
                            │
                   新会话开局读 INDEX / smartwrite://rules ──► 同类错误不再犯
```

### 对外暴露：4 个工具 + 1 个资源

| 名称 | 类型 | 作用 |
|---|---|---|
| `read_file` | 工具 | 读文件并登记内容指纹（sha256），建立"读后写"前提。返回文件全文。 |
| `smart_edit` | 工具 | 定点唯一替换；写前 CAS 校验、锚点唯一、幂等，写后回读自检、原子写。支持 `preview=true` 干跑出 diff。 |
| `remember_failure` | 工具 | 按“全局规则 / 文件特例”沉淀失败；支持稳定根因代码、项目标识和相对路径。 |
| `recall_edit_rules` | 工具 | 编辑具体文件前，召回该文件的精确特例和跨文件全局规则。 |
| `smartwrite://rules` | 资源 | 开局注入全局规则正文和文件特例摘要。 |

### `smart_edit` 的返回是**结构化信号**，直接决定 AI 下一步

- `OK ...` / `OK[NoOp] ...` —— 成功，或目标状态已存在的幂等跳过。
- `PREVIEW ...` —— `preview=true` 干跑：已通过全部校验，返回 diff 但**未写盘**。→ 给用户看 diff，确认后用**相同 old/new** 以 `preview=false` 写入。
- `ERR[Unread]` —— 没先 `read_file`。→ 先读。
- `ERR[Stale]` —— 磁盘指纹与上次读取不符（被格式化 / 他人改动）。→ 重新 `read_file` 再改，切勿覆盖。
- `ERR[NotFound]` —— old 锚点不存在（旧版本 / 幻觉）。→ 重新 `read_file`，别硬写。
- `ERR[Ambiguous]` —— old 出现多次，盲替会重复。→ 给 old 补上下文使其唯一。
- `WARN[Duplicate]` —— 写入成功但检测到同名方法 / 类 / import 出现 ≥2 次。→ 人工确认是否回滚。

### 六道防御机制（`performSmartEdit` 的执行顺序）

1. **M1 读后写**：未 `read_file` → `ERR[Unread]`。
2. **M2 CAS 乐观锁**：磁盘指纹 ≠ 上次读取 → `ERR[Stale]`（还会识别"你刚 preview 的那份 diff 已过期"）。
3. **M4 幂等**：目标状态已存在 → `OK[NoOp]` 跳过，不重复追加。
4. **M3 唯一锚点**：old 出现 0 次 → `ERR[NotFound]`；>1 次 → `ERR[Ambiguous]`（防重复的核心）。
5. **M6 原子写**：临时文件 + `fdatasync` + `rename`，永不出现半写状态。
6. **M5 写后自检**：回读校验 + 结构化查重（近似正则，能抓"整方法 / 类 / import / package 写两遍"）→ `WARN[Duplicate]`。

### 两级记忆的沉淀与召回

- **全局规则**以 `error_type + cause_code` 为身份，例如 `Duplicate + NON_UNIQUE_ANCHOR`。不同文件发生相同根因会合并 `hits`，用于沉淀跨文件通用行为。
- **文件特例**以 `project_id + 相对路径哈希 + error_type + cause_code` 为身份。同名但不同目录的文件不会碰撞，只在召回对应文件时注入。
- JSON v2 规则把同一身份下的 lesson 变体和示例分别计数，避免新 lesson 覆盖旧经验；每条规则最多保留 5 个 lesson 和 10 个示例。
- `smartwrite://rules` 开局注入 Top-20 全局规则正文和 Top-10 文件特例摘要；编辑具体文件前用 `recall_edit_rules` 获取精确文件特例。

新版调用示例：

```json
{
  "file": "D:/project/src/UserService.java",
  "error_type": "Duplicate",
  "cause_code": "NON_UNIQUE_ANCHOR",
  "scope": "global",
  "project_root": "D:/project",
  "project_id": "demo",
  "lesson": "old 出现多次时必须补充上下文使其唯一，不得退化为追加。"
}
```

简化的三参数调用仍可使用，默认写成 `file / GENERIC` 规则。

---

## 配置步骤

### 前置要求

- Node.js ≥ 18
- 一个支持 MCP server 的客户端（joycode / Claude Desktop 等）

### 1. 克隆并安装

```bash
git clone <本仓库地址> smart-write
cd smart-write
npm install
```

### 2. 构建（产出 `dist/server.js`）

```bash
npm run typecheck   # 可选：类型检查
npm run build       # 编译到 dist/
```

> `dist/` 不入 git，克隆后**必须自己 build**（或用下方免构建方式）。

### 3. 取得本机绝对路径（注册时要用）

```bash
pwd   # 例如 /Users/you/mcp/smart-write —— 下面用 <ABS_PATH> 指代它
```

### 4. 在 MCP 客户端注册

在客户端的 MCP 配置里加一项，把 `<ABS_PATH>` 换成上一步的真实路径。

**生产（先 `npm run build`）：**

```json
{
  "mcpServers": {
    "smart-write": {
      "command": "node",
      "args": ["<ABS_PATH>/dist/server.js"]
    }
  }
}
```

**开发（免构建，需本机有 npx/tsx）：**

```json
{
  "mcpServers": {
    "smart-write": {
      "command": "npx",
      "args": ["tsx", "<ABS_PATH>/src/server.ts"]
    }
  }
}
```

重启客户端后，工具列表里应出现 `read_file` / `smart_edit` / `remember_failure` / `recall_edit_rules`。

### 5. 把 smart_edit 变成"唯一合法写入路径"（关键）

光有工具不够，必须禁掉内置全量写。把下面这段粘进 **客户端的规则 / 团队规范文件**（把 `<ABS_PATH>` 换成真实路径）：

```markdown
# 编辑纪律（强制）
1. 禁止使用内置全量文件写入/覆盖。所有文件修改必须走 smart_edit 工具。
2. 编辑任何文件前，先用 recall_edit_rules 召回适用规则，再用 read_file 读取它（否则 smart_edit 会返回 ERR[Unread]）。
3. 写入分级（preview 只买"人工看 diff 再放行"，不买安全——M1~M6 六道校验在单步 preview=false 时同样全跑）：
   - **高风险改动**走两步：先以 preview=true 拿 diff 展示给用户，确认后再用**相同的 old/new** 以 preview=false 写入。高风险 = 改动范围大 / 关键路径 / 你对锚点或结果没把握 / 用户要求先看。
   - **低风险改动**（小范围、锚点明确、你有把握）可直接 preview=false 单步写入，省去 preview 往返。
   - 拿不准时，按高风险走两步。
4. smart_edit 返回 ERR[...] 时：不得原样重试，必须按错误提示行动——
   - ERR[Stale]/ERR[NotFound] → 重新 read_file 再改；
   - ERR[Ambiguous] → 给 old 补充上下文使其唯一。
5. 当同一文件累计 ≥2 次 ERR，或任务收尾时，调用 remember_failure 归纳规则。
6. 每次新会话开局读取 MCP 资源 smartwrite://rules；编辑具体文件前调用 recall_edit_rules，遵守其中已沉淀的全局规则和文件特例。
```

---

## 闭环如何咬合（试错成本 → 长期记忆）

1. 模型基于旧快照想改某文件；
2. `smart_edit` 发现磁盘指纹不符 → `ERR[Stale]`，**写坏被拦下**；
3. 规则要求重新 `read_file` 再改 → 成功；
4. 同类 Stale 第 2 次 → `remember_failure(...)` 按通用根因或文件特例归纳；
5. 下次开局读取全局规则、编辑前精确召回文件特例 → 同类错误不再发生。

---

## 记忆库与 git

- `memory/INDEX.md` 作为**开局注入模板**被 git 跟踪（HEAD 保留纯模板）。运行时追加的规则行是纯本地数据、含真实项目路径，不入库 —— 靠 skip-worktree 让 git 忽略本地差异：

  ```bash
  git update-index --skip-worktree memory/INDEX.md
  ```

- `memory/rules/global/` 和 `memory/rules/scoped/` 是两级 JSON 事实源，整个 `memory/rules/` 不入 git，是每个人本地运行产生的私有记忆。
- `memory/rules_old/` 仅作为旧数据人工备份，运行时不会扫描或注入。

---

## 说明与边界

- `readRegistry` / `previewRegistry` 是**进程内内存**，客户端重启即清空 —— 这是有意的，它只在单次会话内有效；跨会话的持久知识全部沉淀在 `memory/`。
- `duplicateScan` 的 Java 正则是够用的**近似版**，能拦住"整个方法被写两遍"这类典型残留；要严谨可换成基于 AST 的检测。
- `smart_edit` 只做**单点唯一替换**，不支持一次多处替换（多处请多次调用，每次锚点唯一），这正是防重复的代价与保证。
- 开局默认注入 Top-20 全局规则正文和 Top-10 文件摘要；文件特例正文通过 `recall_edit_rules` 精确召回。可在 `src/memory.ts` 调整相应常量。
