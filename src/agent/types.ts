// Settings配置
export interface ModelConfig {
  name: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  baseUrl: string;
  /**
   * OpenAI 认证方式：
   * - api-key（默认）：使用 apiKey 调用 OpenAI 兼容接口
   * - codex：复用本机 `codex login`，通过 Codex App Server 调用模型
   */
  auth?: 'api-key' | 'codex';
  /** Codex CLI 可执行文件路径，默认从 PATH 查找 `codex`。 */
  codexCommand?: string;
  /** 单次模型调用的重试策略；省略时使用安全默认值。 */
  retry?: {
    /** 包含首次请求在内的最大尝试次数，默认 3；设为 1 可关闭重试。 */
    maxAttempts?: number;
    /** 首次重试等待时间，默认 500ms。 */
    baseDelayMs?: number;
    /** 指数退避等待上限，默认 8,000ms。 */
    maxDelayMs?: number;
    /** 每次尝试的超时时间，默认 300,000ms。 */
    requestTimeoutMs?: number;
  };
}

export interface Settings {
  models: ModelConfig[];
  activeModel: string;
  enabledTools: string[];
  enabledSkills: string[];
  enabledSubagents: string[];
  maxRounds: number;
  env: Record<string, string>;
}

// LLM
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  content: string;
  thinking?: string;
  stopReason: string;
  usage?: TokenUsage;
}

// 工具调用状态
export interface ToolCallStatus {
  type: 'tool' | 'skill' | 'subagent';
  name: string;
  status: 'calling' | 'success' | 'error';
  result?: string;
  error?: string;
}
