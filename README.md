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
                     remember_failure ──归纳──► memory/rules/*.md
                            │
                   新会话开局读 INDEX / smartwrite://rules ──► 同类错误不再犯
```

### 对外暴露：3 个工具 + 1 个资源

| 名称 | 类型 | 作用 |
|---|---|---|
| `read_file` | 工具 | 读文件并登记内容指纹（sha256），建立"读后写"前提。返回文件全文。 |
| `smart_edit` | 工具 | 定点唯一替换；写前 CAS 校验、锚点唯一、幂等，写后回读自检、原子写。支持 `preview=true` 干跑出 diff。 |
| `remember_failure` | 工具 | 把一次失败归纳成规则写入 `memory/`（带查重，同类只累加不重复）。 |
| `smartwrite://rules` | 资源 | 聚合已沉淀规则的 markdown 块，供新会话开局读取注入。 |

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

### 记忆的沉淀与注入

- 失败被拦下 → `remember_failure` 归纳成带 frontmatter 的规则文件写入 `memory/rules/`。同 `文件+错误类型` 只累加 `hits`、**不新建文件**，所以规则数上界是 `唯一文件数 × 错误类型数`，不是失败次数。
- 开局注入时，`smartwrite://rules` 资源按 **`hits` 降序取 Top-N（默认 30）**注入完整规则，长尾只在 `INDEX.md` 留摘要行、需要时按路径读取。注入 token **有上界**，不随规则库无限膨胀。调整上限见 `src/memory.ts` 里的 `MAX_INJECTED_RULES`。

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

重启客户端后，工具列表里应出现 `read_file` / `smart_edit` / `remember_failure`。

### 5. 把 smart_edit 变成"唯一合法写入路径"（关键）

光有工具不够，必须禁掉内置全量写。把下面这段粘进 **客户端的规则 / 团队规范文件**（把 `<ABS_PATH>` 换成真实路径）：

```markdown
# 编辑纪律（强制）
1. 禁止使用内置全量文件写入/覆盖。所有文件修改必须走 smart_edit 工具。
2. 编辑任何文件前，必须先用 read_file 读取它（否则 smart_edit 会返回 ERR[Unread]）。
3. 两步写入：先以 preview=true 调 smart_edit 拿到 diff，展示给用户；用户确认后，再用**相同的 old/new** 以 preview=false 实际写入。未经确认不得直接写入。
4. smart_edit 返回 ERR[...] 时：不得原样重试，必须按错误提示行动——
   - ERR[Stale]/ERR[NotFound] → 重新 read_file 再改；
   - ERR[Ambiguous] → 给 old 补充上下文使其唯一。
5. 当同一文件累计 ≥2 次 ERR，或任务收尾时，调用 remember_failure 归纳规则。
6. 每次新会话开局，先读取 <ABS_PATH>/memory/INDEX.md（或读取 MCP 资源 smartwrite://rules），遵守其中已沉淀的规则。
```

---

## 闭环如何咬合（试错成本 → 长期记忆）

1. 模型基于旧快照想改某文件；
2. `smart_edit` 发现磁盘指纹不符 → `ERR[Stale]`，**写坏被拦下**；
3. 规则要求重新 `read_file` 再改 → 成功；
4. 同类 Stale 第 2 次 → `remember_failure(...)` 归纳成规则；
5. 下次开局读 `INDEX.md`，模型开局就知道该文件要先重读 → 同类错误不再发生。

---

## 记忆库与 git

- `memory/INDEX.md` 作为**开局注入模板**被 git 跟踪（HEAD 保留纯模板）。运行时追加的规则行是纯本地数据、含真实项目路径，不入库 —— 靠 skip-worktree 让 git 忽略本地差异：

  ```bash
  git update-index --skip-worktree memory/INDEX.md
  ```

- `memory/rules/` 整个目录不入 git，是每个人本地跑出来的私有记忆。

---

## 说明与边界

- `readRegistry` / `previewRegistry` 是**进程内内存**，客户端重启即清空 —— 这是有意的，它只在单次会话内有效；跨会话的持久知识全部沉淀在 `memory/`。
- `duplicateScan` 的 Java 正则是够用的**近似版**，能拦住"整个方法被写两遍"这类典型残留；要严谨可换成基于 AST 的检测。
- `smart_edit` 只做**单点唯一替换**，不支持一次多处替换（多处请多次调用，每次锚点唯一），这正是防重复的代价与保证。
- Top-N 注入默认 30 条。真实项目跑久了规则变多时，靠 `hits` 排序让高频教训优先注入；若嫌注入过重或过薄，改 `src/memory.ts` 的 `MAX_INJECTED_RULES`。
