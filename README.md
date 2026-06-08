# MyAgent VSCode Extension

MyAgent 是一个支持自定义 Agent 的 VSCode 扩展。用户可以通过 `.myagent/` 配置目录定义系统提示词、工具、技能和子代理，并在 VSCode 侧边栏 webview 中与 Agent 对话。

当前后端运行在 VSCode extension host 中，前端是 React webview。LLM 支持 Anthropic 和 OpenAI 两类 provider。

## 功能特性

- 自定义 Agent：通过 `AGENT.md` 配置系统提示词，支持 YAML front matter 和 `${workspace}` / `${components}` 占位符。
- 双源配置：支持 workspace 配置和 `~/.myagent/` home 配置，workspace 同名组件覆盖 home 组件。
- 多模型：支持 Anthropic 与 OpenAI，并可在 UI 中切换模型。
- 工具系统：动态加载 `tools/*/metadata.json` 和 `index.js`，工具执行时会切换到工作区目录。
- 技能系统：读取 `skills/*/SKILL.md`，作为上下文注入给 Agent，不直接执行。
- 子代理：读取 `subagents/*/AGENT.md`，通过独立 child Session 执行专门任务。
- 组件管理：webview 可启用/禁用 tool、skill、subagent，支持 `["*"]` 通配符。
- 快捷指令：输入框支持 `/tool:`、`/skill:`、`/subagent:` 自动补全。
- 历史消息：webview 消息保存到 VSCode `workspaceState`，并支持手动/自动压缩历史。

## 快速开始

安装依赖：

```bash
npm install
```

开发构建：

```bash
npm run webpack
```

TypeScript watch：

```bash
npm run watch
```

生产构建：

```bash
npm run vscode:prepublish
```

在 VSCode 中按 `F5` 启动 Extension Development Host。

## 测试

```bash
npm run unit
npm run unit -- --coverage
npm run unit -- test/agent/executor.test.ts
npm run test
```

单元测试使用 Jest + `ts-jest`，测试文件位于 `test/`。VSCode API 通过 `test/mocks/vscode.ts` mock，默认 workspace 路径为 `/workspace`。

## 项目结构

```text
myagent-vscode/
├── src/
│   ├── extension.ts
│   ├── FloatingPanelProvider.ts
│   ├── agent/
│   │   ├── runtime.ts
│   │   ├── session.ts
│   │   ├── executor.ts
│   │   ├── xml-parser.ts
│   │   ├── types.ts
│   │   ├── config/
│   │   │   └── manager.ts
│   │   ├── component/
│   │   │   ├── loader-types.ts
│   │   │   ├── filesystem-loader.ts
│   │   │   ├── registry.ts
│   │   │   ├── types.ts
│   │   │   ├── tools/
│   │   │   ├── skills/
│   │   │   └── subagents/
│   │   ├── llm/
│   │   └── message/
│   └── webview/
│       ├── App.tsx
│       ├── simple.tsx
│       └── components/
├── test/
├── dist/
├── out/
├── resources/
├── package.json
├── tsconfig.json
├── webpack.config.js
└── jest.config.js
```

## 架构

运行时分为四层：

```text
ConfigManager -> ComponentRegistry -> AgentRuntime -> Session
```

执行流程：

```text
InputArea
  -> vscode.postMessage('execute-task')
  -> FloatingPanelProvider.ensureSession()
  -> Session.execute(content)
  -> MessageManager.addUserMessage()
  -> AgentExecutor.run(messages, ToolContext, maxRounds)
     -> LLM chat
     -> XMLParser.parse(response)
     -> execute tool / load skill / run subagent
     -> append result as user message
     -> continue until no XML calls or maxRounds reached
  -> MessageManager.addAssistantMessage(reply)
  -> webview.postMessage('agent-response')
```

### 后端模块

- `src/extension.ts`：扩展激活入口，创建 `AgentRuntime`，注册 `myagent-sidebar-view` 和 `myagent.importConfig` 命令。
- `src/FloatingPanelProvider.ts`：连接 webview 与运行时。它持有一个长生命周期 `Session`，配置 reload 或组件开关变化后会重建 session。
- `src/agent/runtime.ts`：运行时核心，持有 `ConfigManager`、`ComponentRegistry`、`LLMClient`，负责创建 session、切换模型、reload 配置、派生 subagent runtime。
- `src/agent/session.ts`：会话容器，持有 `MessageManager` 和 `AgentExecutor`。子代理通过 `runSubagent()` 创建 child Session。
- `src/agent/executor.ts`：多轮 Agent 执行循环。负责调用 LLM、解析 XML、执行组件、回传 token/tool/compress 回调。
- `src/agent/xml-parser.ts`：基于 `fast-xml-parser` 解析 `<tool>`、`<skill>`、`<subagent>` 调用。
- `src/agent/config/manager.ts`：加载 workspace/home settings，并按组件来源判断启用状态。
- `src/agent/component/registry.ts`：聚合组件加载结果，支持 `filter()`、`filterHomeOnly()` 和 `find/list` 查询。
- `src/agent/component/filesystem-loader.ts`：从文件系统加载 `AGENT.md`、tools、skills、subagents。
- `src/agent/llm/`：`LLMClient` 接口，以及 Anthropic/OpenAI client 实现。
- `src/agent/message/`：消息历史、系统上下文、token 统计、历史压缩摘要。

### 前端模块

- `src/webview/App.tsx`：React 根组件，处理 VSCode message 事件和全局状态。
- `Header`：显示配置路径、token 使用量和导入入口。
- `ChatArea`：展示用户消息、Agent 回复和工具调用状态。
- `InputArea`：输入框、模型选择、快捷指令、清空/重载/压缩入口。
- `ComponentSelector`：按 tools/skills/subagents 分类管理组件启用状态。

## 配置系统

配置目录结构：

```text
.myagent/
├── AGENT.md
├── settings.json
├── tools/
│   └── tool-name/
│       ├── metadata.json
│       └── index.js
├── skills/
│   └── skill-name/
│       └── SKILL.md
└── subagents/
    └── agent-name/
        └── AGENT.md
```

`settings.json` 示例：

```json
{
  "models": [
    {
      "name": "Claude Sonnet",
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKey": "your-api-key",
      "baseUrl": "https://api.anthropic.com"
    },
    {
      "name": "GPT-4",
      "provider": "openai",
      "model": "gpt-4",
      "apiKey": "your-api-key",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "activeModel": "Claude Sonnet",
  "enabledTools": ["*"],
  "enabledSkills": [],
  "enabledSubagents": [],
  "maxRounds": 10,
  "env": {
    "ANTHROPIC_THINKING": "true",
    "MAX_TOKENS": "100000"
  }
}
```

字段说明：

- `models`：可选模型列表。
- `activeModel`：当前默认模型名称。
- `enabledTools` / `enabledSkills` / `enabledSubagents`：启用组件列表，`["*"]` 表示全部启用。
- `maxRounds`：一次任务最多执行多少轮 LLM/tool 循环。
- `env`：运行时环境变量。`ANTHROPIC_THINKING=true` 可开启 Anthropic extended thinking。

## 组件格式

### Tool

```text
.myagent/tools/tool-name/
├── metadata.json
└── index.js
```

`metadata.json`：

```json
{
  "name": "tool-name",
  "description": "Tool description",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Query text"
      }
    },
    "required": ["query"]
  }
}
```

`index.js`：

```javascript
module.exports = {
  execute: async function(args, context) {
    // context.env
    // context.workspaceDir
    // context.availableComponents
    return `received: ${args.query}`;
  }
};
```

### Skill

```markdown
---
name: skill-name
description: Skill description
---

# Skill Name

Skill instructions and guidelines.
```

### Subagent

```markdown
---
name: code-reviewer
description: Review code changes
tools: []
skills: []
---

# Code Reviewer

You review code for correctness, maintainability, and missing tests.
```

## XML 调用格式

LLM 输出通过 XML 标签触发组件调用。解析器设置了 `ignoreAttributes: true`，因此必须使用子元素，不要使用属性。

Tool：

```xml
<tool>
  <name>tool-name</name>
  <args>
    <query>hello</query>
  </args>
</tool>
```

Skill：

```xml
<skill>skill-name</skill>
```

Subagent：

```xml
<subagent>
  <name>code-reviewer</name>
  <question>请审查当前改动</question>
</subagent>
```

`<args>` 中包含特殊字符时可以使用 CDATA：

```xml
<tool>
  <name>write-file</name>
  <args>
    <content><![CDATA[<div>Hello</div>]]></content>
  </args>
</tool>
```

## Webview 消息协议

webview -> extension：

- `webview-ready`
- `import-config`
- `reload-config`
- `request-messages`
- `save-messages`
- `clear-messages`
- `compress-history`
- `execute-task`
- `toggle-component`
- `switch-model`

extension -> webview：

- `config-loaded`
- `config-updated`
- `agent-response`
- `tool-call-status`
- `token-usage`
- `restore-messages`
- `error`
- `theme-changed`

## Webpack

`webpack.config.js` 定义两个 bundle：

- extension：`src/extension.ts` -> `dist/extension.js`，Node.js target，`vscode` externalized。
- webview：`src/webview/App.tsx` -> `dist/webview.js`，web target，UMD。

`package.json` 当前扩展入口是 `./out/extension.js`，因此如果通过 `out` 运行扩展，需要同时运行 TypeScript 编译；如果通过 webpack bundle 发布，需要保持入口与 `dist/extension.js` 一致。

## 故障排除

扩展无法激活：

1. 确认已配置可用模型，且 `activeModel` 对应 `models` 中的名称。
2. 确认 `out/extension.js` 或实际入口文件存在。
3. 确认 `dist/webview.js` 存在。
4. 查看 VSCode Output / Developer Tools 中的错误信息。

Agent 运行错误：

1. 检查 `settings.json` 是否是合法 JSON。
2. 检查 API key、base URL 和模型名称是否有效。
3. 检查启用列表是否包含需要使用的 tool/skill/subagent。
4. 检查 tool 的 `index.js` 是否导出 `execute(args, context)`。

UI 显示异常：

1. 运行 `npm run webpack` 重新构建 webview。
2. 执行 `Developer: Reload Window`。
3. 打开 Webview Developer Tools 检查前端错误。
