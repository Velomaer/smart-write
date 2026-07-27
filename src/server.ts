#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fingerprint, performSmartEdit, readRegistry } from "./core.js";
import { rememberFailure, loadRules } from "./memory.js";

const server = new McpServer({ name: "smart-write", version: "1.0.0" });

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

server.tool(
  "read_file",
  "读取文件并登记内容指纹。编辑前必须先调用它（读后写）。返回文件全文。",
  { path: z.string().describe("文件路径，建议绝对路径") },
  async ({ path }) => {
    const abs = resolve(path);
    const content = readFileSync(abs, "utf8");
    readRegistry.set(abs, fingerprint(content));
    return text(content);
  },
);

server.tool(
  "smart_edit",
  "防御性编辑：CAS 指纹校验 + 唯一锚点替换 + 幂等 + 写后回读。用于替代全量覆盖，禁止用它做整份文件替换。失败时返回结构化错误（ERR[...] / WARN[...]）供归纳成规则。",
  {
    path: z.string().describe("文件路径，建议绝对路径"),
    old: z.string().describe("要被替换的原始片段，必须在文件中唯一出现"),
    new: z.string().describe("替换后的新片段"),
  },
  async ({ path, old, new: newStr }) => {
    const abs = resolve(path);
    const result = performSmartEdit(abs, old, newStr);
    return text(result.message);
  },
);

server.tool(
  "remember_failure",
  "将一次 smart_edit 失败归纳成长期规则并写入记忆库（带查重）。当同一文件累计 ≥2 次 ERR，或任务收尾复盘时调用。",
  {
    file: z.string().describe("发生失败的文件"),
    error_type: z.string().describe("根因类型：Stale/NotFound/Ambiguous/Duplicate/VerifyFail 等"),
    lesson: z.string().describe("下次应改变的行为，一句话"),
  },
  async ({ file, error_type, lesson }) => {
    return text(rememberFailure(file, error_type, lesson));
  },
);

server.registerResource(
  "edit-rules",
  "smartwrite://rules",
  {
    title: "Smart-Write 编辑规则",
    description: "已沉淀的编辑失败规则（INDEX + rules/*）。新会话可读取本资源作为开局注入。",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: loadRules() || "（暂无已沉淀规则）",
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);