## Agent Framework

一个高度灵活的智能体框架，支持多种语言模型和工具集成，旨在帮助开发者构建强大的AI助手。

### Agent的组成

Agent的结构由一个文件夹组成，包含以下核心组件：

- `settings.json`：Agent的配置文件，定义了环境变量、权限和其他设置。模型的相关配置也可以放在这里
- `/tools`：工具文件夹，包含Agent可以使用的各种工具，如文件操作、网络请求等。
- `/skills`：技能文件夹，包含Agent可以执行的各种技能，如搜索、翻译、执行命令等。满足anthropic skill规范
- `/subagents`：子代理文件夹，包含Agent可以调用的子代理，如LLM、工具代理等。
- `AGENT.md`：Agent的文档文件，描述了Agent的功能、使用方法和其他相关信息。

### 目录结构

Agent 能力来源于两个位置，优先级：`./myagent` > `~/.myagent`

```
~/.myagent/                    # 全局基础配置
  settings.json
  AGENT.md                     # Agent定义文档
  /tools/
    {tool_name}/
      index.js                 # 工具函数实现
      metadata.json            # 工具元数据
  /skills/
    {skill_name}/
      SKILL.md                 # 技能定义文件
  /subagents/
    {subagent_name}/
      AGENT.md                 # 子代理定义
      /tools/                  # 子代理专属工具
      /skills/                 # 子代理专属技能

./myagent/                     # 项目级配置（优先级高）
  (同上结构)
```

### Tool（工具）

#### 目录结构
```
/tools/
  {tool_name}/
    index.js                 # 工具函数实现
    metadata.json            # 工具元数据
```

#### index.js 规范

导出为一个JavaScript函数：

```javascript
// 方式一：CommonJS
module.exports = {
  name: 'fileRead',
  description: '读取文件内容',
  parameters: { ... },
  execute: async function(args, context) {
    const fs = require('fs').promises;
    const content = await fs.readFile(args.path, 'utf-8');
    return content;
  }
};

// 方式二：ES Module
export const name = 'fileRead';
export const description = '读取文件内容';

export const parameters = { ... };

export async function execute(args, context) {
  // 工具实现
  return result;
}
```

参数说明：
- args：从XML解析的参数对象
- context：执行上下文，包含env环境变量、workspaceDir工作目录等

#### metadata.json 规范
```json
{
  "name": "fileRead",
  "description": "读取文件内容",
  "version": "1.0.0",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "文件路径"
      }
    },
    "required": ["path"]
  },
  "dependencies": ["fs-extra"],
  "enabled": true
}
```

#### 依赖检查

工具的 `dependencies` 字段列出所需的npm包。执行前检查：

- 如果依赖不存在，抛出错误，提示用户安装
- 用户可通过 `npm install` 安装依赖

#### 触发格式
```xml
<tool>
  <name>fileRead</name>
  <args>
    <path>/a.txt</path>
  </args>
</tool>
```

### Skill（技能）

#### 目录结构
```
/skills/
  {skill_name}/
    SKILL.md                 # 技能定义文件
    ...                      # 其他技能相关文件
```

#### SKILL.md 规范

文件头部包含YAML元数据：

```markdown
---
name: debugging
description: 帮助调试代码问题，分析错误原因
---

# Skill 内容...

## 使用方法
...
```

元数据提取：
- name：技能名称
- description：技能描述

内容提取：读取SKILL.md中除元数据外的其他内容

#### 触发格式
```xml
<skill>superpowers:brainstorming</skill>
```

### Subagent（子代理）

#### 目录结构
```
/subagents/
  {subagent_name}/
    AGENT.md                 # 子代理定义
    /tools/                  # 子代理专属工具
    /skills/                 # 子代理专属技能
    /subagents/              # 子代理的子代理（可选）
```

#### AGENT.md 元数据

子代理的AGENT.md头部也包含YAML元数据：

```markdown
---
name: code-reviewer
description: 专业的代码审查代理
---

# Agent 内容...
```

#### 执行机制

Subagent创建独立的LLM调用（递归执行）：

1. 隔离策略：
   - 不继承当前项目的 `./myagent/` 配置
   - 继承全局 `~/.myagent/` 的 tools/skills/subagents
   - 配置文件（settings.json）共享父Agent的配置

2. 调用流程：
   ```
   父Agent LLM
       ↓ 返回 <subagent> 标签
   加载subagent定义
       ↓
   创建新LLM调用（使用subagent的AGENT.md作为system prompt）
       ↓
   执行subagent的tools/skills（来自~/.myagent）
       ↓
   执行完成，返回最后一轮结果给父Agent
   ```

3. 返回结果：将最后一轮LLM的文本回复作为结果，拼接在父Agent的对话中

#### 触发格式
```xml
<subagent>
  <name>code-reviewer</name>
  <question>请审查这段代码</question>
</subagent>
```

### 能力清单

通过 `settings.json` 中的配置项控制向 LLM 暴露哪些能力：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `enabledTools` | 启用的工具列表 | `["*"]` |
| `enabledSkills` | 启用的技能列表 | `["*"]` |
| `enabledSubagents` | 启用的子代理列表 | `["*"]` |
| `maxRounds` | 最大执行轮次 | 10 |

支持通配符（如 `"enabledTools": ["*"]` 默认启用全部）。

### settings.json 规范

```json
{
  "models": [
    {
      "name": "claude-sonnet",
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKey": "sk-ant-...",
      "baseUrl": "https://api.anthropic.com"
    },
    {
      "name": "gpt-4o",
      "provider": "openai",
      "model": "gpt-4o",
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "activeModel": "claude-sonnet",
  "enabledTools": ["*"],
  "enabledSkills": ["*"],
  "enabledSubagents": ["*"],
  "maxRounds": 10,
  "env": {
    // 自定义环境变量，注入到工具执行环境
  }
}
```

配置说明：

| 字段 | 说明 |
|------|------|
| `models` | 模型列表，支持多个LLM provider |
| `models[].name` | 模型显示名称 |
| `models[].provider` | 提供商类型：`anthropic` 或 `openai` |
| `models[].model` | 模型名称 |
| `models[].apiKey` | API密钥 |
| `models[].baseUrl` | API端点URL |
| `activeModel` | 当前使用的模型名称 |
| `enabledTools` | 启用的工具列表 |
| `enabledSkills` | 启用的技能列表 |
| `enabledSubagents` | 启用的子代理列表 |
| `maxRounds` | Agent最大执行轮次 |
| `env` | 自定义环境变量 |

### 组件描述提取

向LLM提供的组件描述来源：

| 组件 | 描述来源 |
|------|----------|
| Tool | `tools/{tool_name}/metadata.json` 的 `description` 字段 |
| Skill | `skills/{skill_name}/SKILL.md` 头部YAML的 `description` 字段 |
| Subagent | `subagents/{subagent_name}/AGENT.md` 头部YAML的 `description` 字段 |

Skill和Subagent的完整内容（去除元数据后）可在执行时加载。