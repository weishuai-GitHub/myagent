import {
  Message,
  ChatOptions,
  ModelToolCall,
  ModelToolDefinition,
  ToolCallStatus,
  TokenUsage
} from './types';
import { AgentConfig, ToolContext } from './component/types';
import { XMLParser } from './xml-parser';
import { ParsedCall } from './xml-parser';
import { LLMClient } from './llm';

export type ToolCallCallback = (status: ToolCallStatus) => void;
export type TokenUsageCallback = (usage: TokenUsage) => void;
export type CompressCallback = (inputTokens: number) => Promise<void>;
export type ExecutionStatusCallback = (status: {
  phase: 'waiting-model' | 'running-component';
  callType?: 'tool' | 'skill' | 'subagent';
  name?: string;
}) => void;

export interface TurnResult {
  reply: string;
  messages: Message[];
  events: TurnEvent[];
  peakInputTokens: number;
}

export type TurnEvent =
  | { type: 'assistant'; content: string }
  | {
      type: 'component-result';
      callId: string;
      callType: 'tool' | 'skill' | 'subagent';
      name: string;
      status: 'success' | 'error';
      content: string;
    };

let nextCallSequence = 0;

function createCallId(): string {
  nextCallSequence += 1;
  return `call-${Date.now().toString(36)}-${nextCallSequence.toString(36)}`;
}

export class AgentExecutor {
  private client: LLMClient;
  private config: AgentConfig;
  private toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>;
  private skillLoader: (skillName: string) => Promise<string>;
  private subagentRunner: (
    subagentName: string,
    question: string,
    signal?: AbortSignal
  ) => Promise<string>;
  private onToolCall?: ToolCallCallback;
  private onTokenUsage?: TokenUsageCallback;
  private onCompress?: CompressCallback;
  private onExecutionStatus?: ExecutionStatusCallback;

  constructor(
    client: LLMClient,
    config: AgentConfig,
    toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>,
    skillLoader: (skillName: string) => Promise<string>,
    subagentRunner: (
      subagentName: string,
      question: string,
      signal?: AbortSignal
    ) => Promise<string>,
    onToolCall?: ToolCallCallback
  ) {
    this.client = client;
    this.config = config;
    this.toolExecutor = toolExecutor;
    this.skillLoader = skillLoader;
    this.subagentRunner = subagentRunner;
    this.onToolCall = onToolCall;
  }

  /**
   * 执行对话循环。
   * @param messages 当前消息历史（系统提示词和组件描述已由 MessageManager 注入）
   * @param context 工具执行上下文
   * @param maxRounds 最大执行轮次
   * @returns 最终回复文本
   */
  async run(messages: Message[], context: ToolContext, maxRounds: number = 10): Promise<string> {
    const result = await this.runTurn(messages, context, maxRounds);
    return result.reply;
  }

  /**
   * 在历史副本上执行完整 turn。调用方传入的 messages 永远不会被修改，
   * 成功后由 Session 显式提交 result.messages。
   */
  async runTurn(
    messages: readonly Message[],
    context: ToolContext,
    maxRounds: number = 10
  ): Promise<TurnResult> {
    const parser = new XMLParser();
    const workingMessages = messages.map(message => ({ ...message }));
    const events: TurnEvent[] = [];
    let peakInputTokens = 0;
    const nativeTools = this.buildNativeTools();

    // 从 env 读取 thinking 配置，默认不开启
    const thinking = context.env.ANTHROPIC_THINKING ? context.env.ANTHROPIC_THINKING === 'true' : false;
    let systemPrompt = this.config.agentPrompt.replace('${workspace}', context.workspaceDir || '')
    .replace('${components}', context.availableComponents || '');
    for (let round = 0; round < maxRounds; round++) {
      const options: ChatOptions = {
        systemPrompt: systemPrompt,
        maxTokens: context.env.MAX_TOKENS ? parseInt(context.env.MAX_TOKENS) : 100000,
        thinking,
        tools: nativeTools.definitions
      };

      this.onExecutionStatus?.({ phase: 'waiting-model' });
      const response = await this.client.chat(
        workingMessages.map(message => ({ ...message })),
        options,
        context.signal
      );

      // 回调 token 使用量
      if (response.usage) {
        peakInputTokens = Math.max(peakInputTokens, response.usage.inputTokens);
        this.onTokenUsage?.(response.usage);
      }

      // 解析响应中的调用
      const calls = response.toolCalls && response.toolCalls.length > 0
        ? this.parseNativeCalls(response.toolCalls, nativeTools.callMap)
        : parser.parse(response.content);

      if (calls.length === 0) {
        // 最终回复只写入历史一次；Session 不再重复追加同一条消息。
        const finalReply = parser.stripXmlTags(response.content);
        workingMessages.push({ role: 'assistant', content: finalReply });
        events.push({ type: 'assistant', content: finalReply });
        return { reply: finalReply, messages: workingMessages, events, peakInputTokens };
      }

      // 带调用的原始 assistant 消息必须进入上下文，供下一轮模型理解调用来源。
      const assistantCallContent = response.content || this.serializeCallsAsXml(calls);
      workingMessages.push({ role: 'assistant', content: assistantCallContent });
      events.push({ type: 'assistant', content: assistantCallContent });

      // 执行调用并追加结果
      for (const call of calls) {
        let result = '';
        let resultStatus: 'success' | 'error' = 'success';
        const callType = call.type as 'tool' | 'skill' | 'subagent';
        const callName = call.name;
        const callId = createCallId();

        // 通知前端：正在调用
        this.onExecutionStatus?.({
          phase: 'running-component',
          callType,
          name: callName
        });
        this.onToolCall?.({ type: callType, name: callName, status: 'calling' });

        switch (call.type) {
          case 'tool':
            try {
              result = this.formatResult(await this.toolExecutor(call.name, call.args, context));
              this.onToolCall?.({ type: callType, name: callName, status: 'success', result: this.truncateResult(result) });
            } catch (e: any) {
              resultStatus = 'error';
              const message = e?.message || String(e);
              result = JSON.stringify({
                ok: false,
                error: {
                  code: 'TOOL_EXECUTION_ERROR',
                  message
                }
              });
              this.onToolCall?.({ type: callType, name: callName, status: 'error', error: message });
            }
            break;
          case 'skill':
            try {
              result = await this.skillLoader(call.name);
              this.onToolCall?.({ type: callType, name: callName, status: 'success', result: this.truncateResult(result) });
            } catch (e: any) {
              resultStatus = 'error';
              result = `Error: ${e.message}`;
              this.onToolCall?.({ type: callType, name: callName, status: 'error', error: e.message });
            }
            break;
          case 'subagent':
            try {
              result = await this.subagentRunner(call.name, call.question, context.signal);
              this.onToolCall?.({ type: callType, name: callName, status: 'success', result: this.truncateResult(result) });
            } catch (e: any) {
              resultStatus = 'error';
              result = `Error: ${e.message}`;
              this.onToolCall?.({ type: callType, name: callName, status: 'error', error: e.message });
            }
            break;
        }

        const modelResult = this.truncateForModel(result);
        workingMessages.push({
          role: 'user',
          content: `${call.type} ${call.name} 结果: ${modelResult}`
        });
        events.push({
          type: 'component-result',
          callId,
          callType,
          name: callName,
          status: resultStatus,
          content: modelResult
        });
      }
    }

    // 达到最大轮次
    const maxRoundsReply = `达到最大执行轮次（${maxRounds}），任务尚未完成。`;
    workingMessages.push({ role: 'assistant', content: maxRoundsReply });
    events.push({ type: 'assistant', content: maxRoundsReply });
    return { reply: maxRoundsReply, messages: workingMessages, events, peakInputTokens };
  }

  switchModel(modelName: string): void {
    this.client.switchModel(modelName);
  }

  setOnToolCall(cb: ToolCallCallback | undefined): void {
    this.onToolCall = cb;
  }

  setOnTokenUsage(cb: TokenUsageCallback | undefined): void {
    this.onTokenUsage = cb;
  }

  setOnCompress(cb: CompressCallback | undefined): void {
    this.onCompress = cb;
  }

  setOnExecutionStatus(cb: ExecutionStatusCallback | undefined): void {
    this.onExecutionStatus = cb;
  }

  private truncateResult(result: string, maxLen: number = 200): string {
    if (!result) return '';
    const str = String(result);
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
  }

  private truncateForModel(result: string, maxLen: number = 50_000): string {
    if (result.length <= maxLen) return result;
    return `${result.slice(0, maxLen)}\n...[工具结果已截断]`;
  }

  private formatResult(result: unknown): string {
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  private buildNativeTools(): {
    definitions: ModelToolDefinition[];
    callMap: Map<string, { type: 'tool' | 'skill' | 'subagent'; name: string }>;
  } {
    const definitions: ModelToolDefinition[] = [];
    const callMap = new Map<string, { type: 'tool' | 'skill' | 'subagent'; name: string }>();
    const add = (
      type: 'tool' | 'skill' | 'subagent',
      name: string,
      description: string,
      parameters: Record<string, unknown>
    ) => {
      const functionName = `${type}_${definitions.length}_${name}`
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 64);
      definitions.push({ name: functionName, description, parameters });
      callMap.set(functionName, { type, name });
    };

    for (const tool of this.config.tools) {
      add('tool', tool.name, tool.description, tool.parameters);
    }
    for (const skill of this.config.skills) {
      add('skill', skill.name, skill.description, {
        type: 'object',
        properties: {},
        additionalProperties: false
      });
    }
    for (const subagent of this.config.subagents) {
      add('subagent', subagent.name, subagent.description, {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '交给子代理处理的完整问题与必要背景'
          }
        },
        required: ['question'],
        additionalProperties: false
      });
    }
    return { definitions, callMap };
  }

  private parseNativeCalls(
    calls: ModelToolCall[],
    callMap: Map<string, { type: 'tool' | 'skill' | 'subagent'; name: string }>
  ): ParsedCall[] {
    const parsed: ParsedCall[] = [];
    for (const call of calls) {
      const mapped = callMap.get(call.name);
      if (!mapped) {
        parsed.push({ type: 'tool', name: call.name, args: call.arguments });
      } else if (mapped.type === 'tool') {
        parsed.push({ type: 'tool', name: mapped.name, args: call.arguments });
      } else if (mapped.type === 'skill') {
        parsed.push({ type: 'skill', name: mapped.name });
      } else {
        parsed.push({
          type: 'subagent',
          name: mapped.name,
          question: typeof call.arguments.question === 'string'
            ? call.arguments.question
            : ''
        });
      }
    }
    return parsed;
  }

  private serializeCallsAsXml(calls: ParsedCall[]): string {
    return calls.map(call => {
      const name = this.escapeXml(call.name);
      if (call.type === 'tool') {
        const args = JSON.stringify(call.args).replace(/]]>/g, '] ]>');
        return `<tool><name>${name}</name><args><![CDATA[${args}]]></args></tool>`;
      }
      if (call.type === 'skill') {
        return `<skill>${name}</skill>`;
      }
      return `<subagent><name>${name}</name><question>${this.escapeXml(call.question)}</question></subagent>`;
    }).join('\n');
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
