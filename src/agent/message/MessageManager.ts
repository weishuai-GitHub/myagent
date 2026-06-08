import { Message, TokenUsage } from '../types';

/** 消息压缩函数类型：接收待压缩的消息列表，返回摘要文本 */
export type SummarizeFn = (messages: Message[]) => Promise<string>;

/** 默认压缩阈值：80k input tokens */
const DEFAULT_COMPRESS_THRESHOLD = 80000;
/** 压缩时保留的最近消息条数（2轮对话 = 4条消息） */
const DEFAULT_KEEP_RECENT = 4;

export class MessageManager {
  /** 系统提示词 */
  private systemPrompt: string = '';
  /** 组件描述（工具/技能/子代理列表） */
  private componentDescriptions: string = '';
  /** 对话历史（不含 system） */
  private history: Message[] = [];
  /** Token 使用统计 */
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  /** 消息压缩阈值（inputTokens） */
  private compressThreshold: number;
  /** 压缩时保留的最近消息条数 */
  private keepRecent: number;

  /** 设置系统提示词 */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** 一次性设置系统上下文（系统提示词 + 组件描述） */
  setSystemContext(systemPrompt: string, components: string): void {
    this.systemPrompt = systemPrompt;
    this.componentDescriptions = components;
  }

  constructor(options?: { compressThreshold?: number; keepRecent?: number }) {
    this.compressThreshold = options?.compressThreshold ?? DEFAULT_COMPRESS_THRESHOLD;
    this.keepRecent = options?.keepRecent ?? DEFAULT_KEEP_RECENT;
  }

  /** 获取组件描述（用于 ToolContext.availableComponents 与 ${components} 占位符） */
  getComponentDescriptions(): string {
    return this.componentDescriptions;
  }

  /** 获取系统提示词 */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /** 追加用户消息 */
  addUserMessage(content: string): void {
    this.history.push({ role: 'user', content });
  }

  /** 追加助手消息 */
  addAssistantMessage(content: string): void {
    this.history.push({ role: 'assistant', content });
  }

  /** 追加任意消息（工具调用结果等） */
  addMessage(message: Message): void {
    this.history.push(message);
  }

  /**
   * 移除最后一条消息（用于出错回滚）
   * @returns 被移除的消息，如果历史为空则返回 undefined
   */
  popLast(): Message | undefined {
    return this.history.pop();
  }

  /** 获取完整消息历史（用于发送给 LLM） */
  getMessages(): Message[] {
    return this.history;
  }

  /** 获取历史消息数量 */
  getLength(): number {
    return this.history.length;
  }

  /** 清空历史（保留 systemPrompt 和 componentDescriptions） */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * 判断是否需要压缩：当前 inputTokens 超过阈值时返回 true。
   * @param inputTokens 最近一次 LLM 调用返回的 inputTokens
   */
  needsCompression(inputTokens: number): boolean {
    return inputTokens > this.compressThreshold;
  }

  /**
   * 压缩历史消息：保留首条（组件描述）和最近 N 条，中间部分由 summarizeFn 生成摘要替代。
   * @param summarizeFn LLM 摘要函数，接收待压缩消息，返回摘要文本
   * @returns 是否执行了压缩
   */
  async compressHistory(summarizeFn: SummarizeFn): Promise<boolean> {
    // history[0] 是组件描述 system message，必须保留
    // 保留最近 keepRecent 条消息
    const minRequired = 1 + this.keepRecent; // 首条 + 近期
    if (this.history.length <= minRequired) {
      return false;
    }

    const head = this.history.slice(0, 1); // 组件描述
    const recent = this.history.slice(-this.keepRecent);
    const oldMessages = this.history.slice(1, -this.keepRecent);

    if (oldMessages.length === 0) {
      return false;
    }

    const summary = await summarizeFn(oldMessages);

    this.history = [
      ...head,
      { role: 'system', content: `[历史对话摘要]\n${summary}` },
      ...recent
    ];

    return true;
  }
  reset(): void {
    this.systemPrompt = '';
    this.componentDescriptions = '';
    this.history = [];
    this.tokenUsage = { inputTokens: 0, outputTokens: 0 };
  }

  /** 累加 token 使用量 */
  addTokenUsage(usage: TokenUsage): void {
    this.tokenUsage.inputTokens = usage.inputTokens;
    this.tokenUsage.outputTokens = usage.outputTokens;
  }

  /** 复位累计 token 计数器（用于 Session.reset） */
  resetTokenUsage(): void {
    this.tokenUsage = { inputTokens: 0, outputTokens: 0 };
  }

  /** 获取 token 使用统计 */
  getTokenUsage(): TokenUsage & { totalTokens: number } {
    return {
      ...this.tokenUsage,
      totalTokens: this.tokenUsage.inputTokens + this.tokenUsage.outputTokens
    };
  }
}
