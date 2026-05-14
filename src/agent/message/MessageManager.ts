import { Message, TokenUsage } from '../types';

export class MessageManager {
  /** 系统提示词 */
  private systemPrompt: string = '';
  /** 组件描述（工具/技能/子代理列表） */
  private componentDescriptions: string = '';

  private availableComponents: string = '';
  /** 对话历史（不含 system） */
  private history: Message[] = [];
  /** Token 使用统计 */
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  /** 设置系统提示词 */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** 设置组件描述 */
  setComponentDescriptions(descriptions: string): void {
    this.componentDescriptions = descriptions;
  }

  setAvailableComponentsFromList(tools: any[], skills: any[], subagents: any[]): void {
    this.availableComponents = `
    [可用工具]: ${tools.map(tool => `${tool}`).join(', ')}
    [可用技能]: ${skills.map(skill => `${skill}`).join(', ')}
    [可用子代理]: ${subagents.map(subagent => `${subagent}`).join(', ')}`;
  }

  getAvailableComponents(): string {
    return this.availableComponents;
  }

  /** 获取系统提示词 */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * 追加用户消息。
   * 第一条用户消息会自动拼接组件描述前缀。
   */
  addUserMessage(content: string): void {
    const isFirst = this.history.length === 0;
    if (isFirst && this.componentDescriptions) {
      this.addMessage({ role: 'system', content: `${this.componentDescriptions}` });
      this.history.push({ role: 'user', content: `用户问题: ${content}` });
    } else {
      this.history.push({ role: 'user', content });
    }
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

  /** 重置全部（包括系统提示词和组件描述） */
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

  /** 获取 token 使用统计 */
  getTokenUsage(): TokenUsage & { totalTokens: number } {
    return {
      ...this.tokenUsage,
      totalTokens: this.tokenUsage.inputTokens + this.tokenUsage.outputTokens
    };
  }
}
