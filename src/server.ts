#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fingerprint, performSmartEdit, readRegistry } from "./core.js";
import { loadRules, loadRulesForFile, rememberFailure } from "./memory.js";

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
  "防御性编辑：CAS 指纹校验 + 唯一锚点替换 + 幂等 + 写后回读。用于替代全量覆盖，禁止用它做整份文件替换。两步写入：先 preview=true 拿到 diff 预览给用户确认，再用相同 old/new 以 preview=false 实际写入。失败时返回结构化错误（ERR[...] / WARN[...]）供归纳成规则。",
  {
    path: z.string().describe("文件路径，建议绝对路径"),
    old: z.string().describe("要被替换的原始片段，必须在文件中唯一出现"),
    new: z.string().describe("替换后的新片段"),
    preview: z.boolean().optional().describe("true=只跑校验并返回 diff 预览、不写盘（dry-run）；false/省略=实际写入。默认先 preview 再写。"),
  },
  async ({ path, old, new: newStr, preview }) => {
    const abs = resolve(path);
    const result = performSmartEdit(abs, old, newStr, preview ?? false);
    return text(result.message);
  },
);

server.tool(
  "remember_failure",
  "将一次 smart_edit 失败归纳成两级长期规则。global 规则按错误类型+根因跨文件复用；file 规则按项目+相对路径+错误类型+根因精确匹配。省略新增参数时默认 file/GENERIC。",
  {
    file: z.string().describe("发生失败的文件"),
    error_type: z.string().describe("错误现象：Stale/NotFound/Ambiguous/Duplicate/VerifyFail 等"),
    cause_code: z.string().optional().describe("稳定根因代码，如 NON_UNIQUE_ANCHOR、REPEATED_SUBMIT；默认 GENERIC"),
    lesson: z.string().describe("下次应改变的行为，一句话"),
    scope: z.enum(["global", "file"]).optional().describe("global=跨文件通用；file=当前文件特例；默认 file"),
    project_root: z.string().optional().describe("项目根目录，用于生成稳定的相对文件标识"),
    project_id: z.string().optional().describe("项目稳定标识；默认使用 project_root 或当前目录名称"),
  },
  async ({ file, error_type, cause_code, lesson, scope, project_root, project_id }) => {
    return text(rememberFailure(file, error_type, lesson, {
      scope,
      causeCode: cause_code,
      projectRoot: project_root,
      projectId: project_id,
    }));
  },
);

server.tool(
  "recall_edit_rules",
  "编辑具体文件前，召回适用于该文件的精确特例和全局规则。文件特例优先返回。",
  {
    file: z.string().describe("准备编辑的文件"),
    project_root: z.string().optional().describe("项目根目录，需与沉淀文件规则时保持一致"),
    project_id: z.string().optional().describe("项目稳定标识，需与沉淀文件规则时保持一致"),
  },
  async ({ file, project_root, project_id }) => {
    return text(loadRulesForFile(file, { projectRoot: project_root, projectId: project_id }));
  },
);

server.registerResource(
  "edit-rules",
  "smartwrite://rules",
  {
    title: "Smart-Write 编辑规则",
    description: "开局规则注入：全局规则正文与文件特例摘要。具体文件请再调用 recall_edit_rules。",
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
