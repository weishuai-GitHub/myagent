// Settings配置
export interface ModelConfig {
  name: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  baseUrl: string;
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
