# MyAgent VSCode Extension

一个支持自定义Agent定义的VSCode插件，提供强大的AI辅助开发功能。

## 功能特性

- **自定义Agent定义**: 支持`.myagent`目录中的Agent配置，支持工作区(`.myagent`)和用户主目录(`~/.myagent`)两级配置
- **多模型支持**: 支持Anthropic (Claude) 和OpenAI (GPT) 模型，运行时可切换
- **Extended Thinking**: 支持Anthropic的extended thinking功能，通过环境变量`ANTHROPIC_THINKING=true`启用
- **工具系统**: 动态加载和执行工具，执行时自动切换到工作区目录
- **技能系统**: 可配置的技能增强Agent能力，自动注入到系统提示词
- **子代理**: 支持子代理处理特定任务
- **组件管理**: 前端可视化启用/禁用工具、技能、子代理，支持`*`通配符
- **快捷指令**: 输入框支持`/tool:`, `/skill:`, `/subagent:`快捷指令，带自动补全
- **消息持久化**: 对话历史自动保存到workspaceState
- **React UI**: 现代化的侧边栏界面，支持深色/浅色主题

## 项目结构

```
myagent-vscode/
├── src/
│   ├── extension.ts              # 插件入口
│   ├── FloatingPanelProvider.ts  # Webview视图提供者
│   ├── agent/
│   │   ├── index.ts              # AgentRuntime (核心运行时)
│   │   ├── executor.ts           # AgentExecutor (对话循环)
│   │   ├── xml-parser.ts         # XML解析器 (解析工具/技能/子代理调用)
│   │   ├── types.ts              # Settings和LLM类型定义
│   │   ├── config/
│   │   │   └── manager.ts        # ConfigManager (双源配置管理)
│   │   ├── component/
│   │   │   ├── index.ts          # 组件模块统一导出
│   │   │   ├── loader.ts         # AgentLoader (组件发现和加载)
│   │   │   ├── types.ts          # 组件通用类型
│   │   │   ├── tools/
│   │   │   │   ├── executor.ts   # 工具加载和执行
│   │   │   │   └── types.ts      # 工具类型定义
│   │   │   ├── skills/
│   │   │   │   ├── loader.ts     # 技能加载和内容获取
│   │   │   │   └── types.ts      # 技能类型定义
│   │   │   └── subagents/
│   │   │       ├── runner.ts     # 子代理加载和运行
│   │   │       └── types.ts      # 子代理类型定义
│   │   ├── llm/
│   │   │   ├── index.ts          # LLMClient接口
│   │   │   ├── factory.ts        # LLM客户端工厂
│   │   │   ├── anthropic.ts      # Anthropic客户端
│   │   │   └── openai.ts         # OpenAI客户端
│   │   └── message/
│   │       └── MessageManager.ts # 消息管理器
│   └── webview/
│       ├── App.tsx               # React主应用
│       ├── simple.tsx            # 简易测试页面
│       └── components/
│           ├── Header.tsx        # 顶部栏 (配置路径+导入按钮)
│           ├── ChatArea.tsx      # 聊天消息区域
│           ├── InputArea.tsx     # 输入区域 (快捷指令+模型选择)
│           └── ComponentSelector.tsx # 组件启用/禁用管理
├── test/                         # 单元测试
├── dist/                         # Webpack编译输出
├── out/                          # TSC编译输出
├── resources/                    # 插件图标资源
├── package.json                  # 插件清单
├── tsconfig.json                 # TypeScript配置
├── webpack.config.js             # Webpack配置
└── jest.config.js                # Jest测试配置
```

## 安装和运行

### 开发环境设置

1. **安装依赖**:
   ```bash
   npm install
   ```

2. **编译项目**:
   ```bash
   npm run webpack
   ```

3. **在VSCode中调试**:
   - 按 `F5` 或选择 "Run and Debug"
   - 从调试配置中选择 "Run Extension in VSCode"

### 生产环境构建

```bash
npm run vscode:prepublish
```

## 配置MyAgent

### 目录结构

MyAgent支持两个配置目录，优先级为 workspace > home：

- **工作区目录**: 项目根目录下的 `.myagent/`
- **用户主目录**: `~/.myagent/`

```
.myagent/
├── AGENT.md           # Agent提示词 (支持YAML front matter)
├── settings.json      # 配置文件
├── skills/            # 技能目录
│   └── skill-name/
│       └── SKILL.md   # 支持YAML front matter (name, description)
├── tools/             # 工具目录
│   └── tool-name/
│       ├── metadata.json
│       └── index.js
└── subagents/         # 子代理目录
    └── agent-name/
        └── AGENT.md   # 支持YAML front matter (name, description)
```

工作区目录中的同名组件会覆盖用户主目录中的组件。

### 配置文件

在 `.myagent/` 目录下创建 `settings.json`：

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
    "NODE_ENV": "development",
    "ANTHROPIC_THINKING": "true"
  }
}
```

**字段说明**:
- `models`: 可用模型列表，支持 `anthropic` 和 `openai` 两种 provider
- `activeModel`: 当前使用的模型名称
- `enabledTools`/`enabledSkills`/`enabledSubagents`: 启用的组件列表，支持 `["*"]` 通配符表示全部启用
- `maxRounds`: Agent执行的最大对话轮次
- `env`: 环境变量，`ANTHROPIC_THINKING=true` 可启用Anthropic extended thinking

在VSCode侧边栏点击"导入配置"按钮加载配置文件。

## 快捷指令

输入框支持以下快捷指令，输入 `/` 即可触发自动补全：

| 指令 | 说明 |
|------|------|
| `/tool:工具名` | 指定使用某个工具 |
| `/skill:技能名` | 指定使用某个技能 |
| `/subagent:代理名` | 指定使用某个子代理 |
| `/clear` | 清空对话历史 |
| `/reload` | 重新加载配置 |

快捷指令可组合使用，用Tab键确认选择。

## 测试

### 运行单元测试

```bash
# 运行所有测试
npm run unit

# 运行测试并生成覆盖率报告
npm run unit -- --coverage
```

### 运行扩展测试

```bash
npm run test
```

## 调试

### 使用VSCode调试

项目已配置多种调试选项：

1. **Run Extension in VSCode** (推荐) - 在VSCode开发环境中运行扩展，支持断点调试
2. **Run Extension (Web Inspector)** - 使用浏览器开发者工具调试React UI
3. **Debug Extension Tests** - 调试扩展集成测试
4. **Debug Jest Tests** - 调试单元测试

## 开发指南

### 添加新工具

1. 在 `.myagent/tools/tool-name/` 创建目录
2. 创建 `metadata.json`:
   ```json
   {
     "name": "tool-name",
     "description": "Tool description",
     "version": "1.0.0",
     "parameters": {
       "type": "object",
       "properties": {
         "param1": {
           "type": "string",
           "description": "Parameter description"
         }
       },
       "required": []
     },
     "dependencies": [],
     "enabled": true
   }
   ```
3. 创建 `index.js`:
   ```javascript
   module.exports = {
     execute: async function(args, context) {
       // context.env - 环境变量
       // context.workspaceDir - 工作区目录 (执行时已自动chdir)
       return result;
     }
   };
   ```

### 添加新技能

1. 在 `.myagent/skills/skill-name/` 创建目录
2. 创建 `SKILL.md`:
   ```markdown
   ---
   name: skill-name
   description: Skill description
   ---

   # Skill Name

   Skill instructions and guidelines...
   ```

### 添加子代理

1. 在 `.myagent/subagents/agent-name/` 创建目录
2. 创建 `AGENT.md`:
   ```markdown
   ---
   name: agent-name
   description: Agent description
   ---

   # Agent Name

   Agent system prompt and instructions...
   ```

## 架构说明

### 后端架构

```
用户输入
    ↓
FloatingPanelProvider (VSCode WebviewViewProvider)
    ↓
AgentRuntime
    ├─→ AgentLoader (发现并加载组件)
    │    ├─→ loadToolsFromDir (workspace优先，覆盖home)
    │    ├─→ loadSkillsFromDir
    │    └─→ loadSubagentsFromDir
    ├─→ ConfigManager (双源配置管理)
    │    ├─→ workspaceSettings (.myagent/settings.json)
    │    └─→ homeSettings (~/.myagent/settings.json)
    ├─→ LLM Client (与AI模型通信)
    │    ├─→ AnthropicClient (支持extended thinking)
    │    └─→ OpenAIClient
    └─→ AgentExecutor (执行对话循环)
         ↓
    MessageManager (管理消息历史和系统提示词)
         ↓
    XMLParser (解析 <tool>/<skill>/<subagent> 调用)
         ↓
    ToolExecutor / SkillLoader / SubagentRunner
         ↓
    返回结果
```

### 前端架构

```
React App (App.tsx)
 ├─→ Header (配置路径显示 + 导入按钮)
 ├─→ ChatArea (消息显示，支持代码块渲染)
 ├─→ InputArea (输入框 + 快捷指令自动补全 + 模型选择)
 │    ├─→ /tool: /skill: /subagent: 组件指令
 │    └─→ /clear /reload 特殊指令
 └─→ ComponentSelector (组件启用管理，支持workspace/home来源标识)
      ↓
   postMessage 与 Extension 通信
      ↓
   调用后端 AgentRuntime
```

## 故障排除

### 扩展无法激活

1. 确认 `dist/` 目录存在且包含 `webview.js`
2. 确认 `out/` 目录存在且包含编译后的扩展代码
3. 检查 `package.json` 中的配置是否正确
4. 查看VSCode输出面板的错误信息

### Agent运行错误

1. 确认 `.myagent` 目录结构正确
2. 检查 `settings.json` 中的API密钥是否有效
3. 验证网络连接和API可访问性
4. 确认 `activeModel` 指向的模型名称存在于 `models` 列表中

### UI显示问题

1. 清除VSCode缓存：`Developer: Reload Window`
2. 重新编译：`npm run webpack`
3. 使用Web Inspector调试React组件