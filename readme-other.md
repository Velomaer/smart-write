# smart-write（使用简介）

一个 **MCP Server**，把 AI 编码时的"内置全量写文件"替换成**带校验的防御性增量写**，专治长上下文下的两类事故：

- **覆盖冲突**：基于过期内容全量写入，把磁盘上别人的改动盖掉。
- **重复残留**：锚点没找到就追加到末尾，同一个方法 / 类被写两遍。

同时会把每次失败**沉淀成规则**，下次开局自动提醒，同类错误不再犯。

装好后会多出三个工具：

- `read_file` —— 读文件（编辑前必须先读）。
- `smart_edit` —— 定点替换，写前校验、写后自检；改坏会被拦下并返回明确错误。
- `remember_failure` —— 把失败归纳成长期规则。

---

## 安装配置

**前置**：Node.js ≥ 18，一个支持 MCP 的客户端（joycode / Claude Desktop 等）。

```bash
git clone <仓库地址> smart-write
cd smart-write
npm install
npm run build      # 产出 dist/server.js
pwd                # 记下这个绝对路径，下一步要用
```

在客户端的 MCP 配置里加一项，把 `<绝对路径>` 换成上面 `pwd` 的结果：

```json
{
  "mcpServers": {
    "smart-write": {
      "command": "node",
      "args": ["<绝对路径>/dist/server.js"]
    }
  }
}
```

重启客户端，工具列表出现 `read_file` / `smart_edit` / `remember_failure` 即成功。

---

## 需要设置的 Rule（关键）

光装工具不够，必须在客户端的**规则 / 规范文件**里加上下面这段，禁掉内置全量写、强制走 smart_edit（把 `<绝对路径>` 换成真实路径）：

```markdown
# 编辑纪律（强制）
1. 禁止使用内置全量文件写入/覆盖。所有文件修改必须走 smart_edit 工具。
2. 编辑任何文件前，必须先用 read_file 读取它。
3. 两步写入：先以 preview=true 拿到 diff 给用户看，确认后再用相同 old/new 以 preview=false 写入。
4. smart_edit 返回 ERR[...] 时不得原样重试，按提示行动：
   - ERR[Stale]/ERR[NotFound] → 重新 read_file 再改；
   - ERR[Ambiguous] → 给 old 补充上下文使其唯一。
5. 同一文件累计 ≥2 次 ERR，或任务收尾时，调用 remember_failure 归纳规则。
6. 每次新会话开局，先读取 <绝对路径>/memory/INDEX.md，遵守其中已沉淀的规则。
```

设置完成后，AI 的所有文件修改都会走这条防御路径。更详细的机制说明见 `README.md`。
