# MyAgent VSCode Extension

一个支持自定义Agent定义的VSCode插件，提供强大的AI辅助开发功能。

## 功能特性

- **自定义Agent定义**: 支持`./myagent`或`~/.myagent`目录中的Agent配置
- **多模型支持**: 支持Anthropic (Claude) 和OpenAI (GPT) 模型
- **工具系统**: 动态加载和执行工具
- **技能系统**: 可配置的技能增强Agent能力
- **子代理**: 支持子代理处理特定任务
- **React UI**: 现代化的侧边栏界面

## 项目结构

```
myagent-vscode/
├── src/
│   ├── agent/              # Agent运行时
│   │   ├── index.ts       # AgentRuntime
│   │   ├── loader.ts      # Agent配置加载器
│   │   ├── executor.ts    # Agent执行器
│   │   ├── types.ts       # 类型定义
│   │   └── xml-parser.ts  # XML解析器
│   ├── config/             # 配置管理
│   │   └── manager.ts
│   ├── llm/                # LLM客户端
│   │   ├── index.ts
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   └── factory.ts
│   ├── tools/              # 工具执行器
│   ├── skills/              # 技能加载器
│   ├── subagents/           # 子代理运行器
│   ├── webview/            # React UI
│   │   ├── App.tsx
│   │   ├── SidebarProvider.ts
│   │   └── components/
│   └── extension.ts         # 插件入口
├── test/                 # 单元测试
├── myagent/              # 示例Agent配置
│   ├── AGENT.md
│   ├── skills/
│   └── settings.example.json
├── dist/                 # 编译输出
├── package.json           # 插件清单
├── tsconfig.json         # TypeScript配置
└── webpack.config.js      # Webpack配置
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
   -从调试配置中选择 "Run Extension in VSCode"

### 生产环境构建

```bash
npm run vscode:prepublish
```

## 配置MyAgent

### 基本配置

在工作目录或用户主目录创建 `myagent` 目录：

```
myagent/
├── AGENT.md           # Agent提示词
├── skills/            # 技能目录
│   └── myagent/
│       └── SKILL.md
└── tools/             # 工具目录
    └── tool-name/
        ├── metadata.json
        └── index.js
```

### 配置文件

创建 `settings.json` 文件配置AI模型：

```json
{
  "models": [
    {
      "name": "Claude 3 Opus",
      "provider": "anthropic",
      "model": "claude-3-opus-20240229",
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
  "activeModel": "Claude 3 Opus",
  "enabledTools": [],
  "enabledSkills": [],
  "enabledSubagents": [],
  "maxRounds": 10,
  "env": {
    "NODE_ENV": "development"
  }
}
```

在VSCode中点击"导入配置"按钮加载此文件。

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

### 测试覆盖率

当前测试覆盖率：
- 总体语句覆盖率: 32.86%
- XML解析器: 100%
- React Header组件: 100%
- LLM工厂: 100%

## 调试

### 使用VSCode调试

项目已配置多种调试选项，可在VSCode中使用：

1. **Run Extension in VSCode** (推荐)
   - 在VSCode开发环境中运行扩展
   - 支持断点调试

2. **Run Extension (Web Inspector)**
   - 使用浏览器开发者工具调试React UI
   - 适用于前端调试

3. **Debug Extension Tests**
   - 调试扩展集成测试
   - 设置断点检查执行流程

4. **Debug Jest Tests**
   - 调试单元测试
   - 支持测试运行时断点

### 使用Chrome DevTools调试React

使用"Run Extension (Web Inspector)"配置后：
1. 启动调试会话
2. Chrome浏览器会自动打开
3. 使用Chrome DevTools检查React组件
4. 支持React Developer Tools扩展

## 开发指南

### 添加新工具

1. 在 `myagent/tools/tool-name/` 创建目录
2. 创建 `metadata.json`:
   ```json
   {
     "name": "tool-name",
     "description": "Tool description",
     "version": "1.0.0",
     "parameters": {
       "param1": {
         "type": "string",
         "description": "Parameter description"
       }
     },
     "dependencies": [],
     "enabled": true
   }
   ```
3. 创建 `index.js`:
   ```javascript
   module.exports = {
     execute: async function(args, context) {
       // 工具执行逻辑
       return result;
     }
   };
   ```

### 添加新技能

1. 在 `myagent/skills/skill-name/` 创建目录
2. 创建 `SKILL.md`:
   ```markdown
   ---
   name: skill-name
   description: Skill description
   ---

   # Skill Name

   Skill instructions and guidelines...
   ```

## 架构说明

### 后端架构

```
用户输入
    ↓
SidebarProvider
    ↓
AgentRuntime
    ├─→ AgentLoader (加载配置)
    ├─→ ConfigManager (管理设置)
    ├─→ LLM Client (与AI模型通信)
    └─→ AgentExecutor (执行Agent逻辑)
         ↓
    XMLParser (解析工具/技能调用)
         ↓
    ToolExecutor / SkillLoader
         ↓
    返回结果
```

### 前端架构

```
React App
 ├─→ Header (配置路径显示)
 ├─→ ChatArea (消息显示)
 ├─→ InputArea (输入和模型选择)
 └─→ ComponentSelector (组件启用管理)
      ↓
   与Extension通信
      ↓
   调用后端AgentRuntime
```

## 故障排除

### 扩展无法激活

1. 确认 `dist/` 目录存在且包含编译后的文件
2. 检查 `package.json` 中的配置是否正确
3. 查看VSCode输出面板的错误信息

### Agent运行错误

1. 确认 `myagent` 目录结构正确
2. 检查 `settings.json` 中的API密钥是否有效
3. 验证网络连接和API可访问性

### UI显示问题

1. 清除VSCode缓存：`Developer: Reload Window`
2. 重新编译：`npm run webpack`
3. 使用Web Inspector调试React组件

## 许可证

MIT License

## 贡献

欢迎贡献！请：
1. Fork项目
2. 创建特性分支
3. 提交更改
4. 推送到分支
5. 创建Pull Request

## 联系方式

有问题或建议？请：
- 创建Issue
- 发送邮件
- 联系维护者
