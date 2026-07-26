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
import { ComponentResultPresenter } from './execution/component-presenter';
import { ExecutionTraceStore } from './execution/trace-store';
import {
  AgentExecutionScope,
  ComponentCallType,
  RunTurnExecutionContext,
  SubagentInvocationContext
} from './execution/types';

interface PreparedComponentCall {
  call: ParsedCall;
  callId: string;
  callType: ComponentCallType;
  callName: string;
  argsOrQuestion?: unknown;
}

interface CompletedComponentCall extends PreparedComponentCall {
  modelContent: string;
  resultStatus: 'success' | 'error';
  cancellationError?: unknown;
}

export type ToolCallCallback = (status: ToolCallStatus) => void;
export type TokenUsageCallback = (usage: TokenUsage) => void;
export type CompressCallback = (inputTokens: number) => Promise<void>;
export type ExecutionStatusCallback = (status: {
  phase: 'waiting-model' | 'running-component';
  callType?: 'tool' | 'skill' | 'subagent';
  name?: string;
  executionId?: string;
  callId?: string;
  parentCallId?: string;
  agentRunId?: string;
  agentName?: string;
  agentPath?: string[];
  agentDepth?: number;
}) => void;

export interface TurnResult {
  reply: string;
  messages: Message[];
  events: TurnEvent[];
  peakInputTokens: number;
}

export type TurnEvent =
  | {
      type: 'assistant';
      content: string;
      turnId?: string;
      displayContent?: string;
      visibility?: 'visible' | 'hidden';
    }
  | {
      type: 'component-result';
      callId: string;
      callType: 'tool' | 'skill' | 'subagent';
      name: string;
      status: 'success' | 'error';
      content: string;
      turnId?: string;
      displayContent?: string;
      visibility?: 'visible' | 'hidden';
    };

export class AgentExecutor {
  private client: LLMClient;
  private config: AgentConfig;
  private toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>;
  private skillLoader: (skillName: string) => Promise<string>;
  private subagentRunner: (
    subagentName: string,
    question: string,
    invocation: SubagentInvocationContext,
    signal?: AbortSignal
  ) => Promise<string>;
  private onToolCall?: ToolCallCallback;
  private onTokenUsage?: TokenUsageCallback;
  private onCompress?: CompressCallback;
  private onExecutionStatus?: ExecutionStatusCallback;
  private readonly presenter = new ComponentResultPresenter();

  constructor(
    client: LLMClient,
    config: AgentConfig,
    toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>,
    skillLoader: (skillName: string) => Promise<string>,
    subagentRunner: (
      subagentName: string,
      question: string,
      invocation: SubagentInvocationContext,
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
    maxRounds: number = 10,
    executionContext?: RunTurnExecutionContext
  ): Promise<TurnResult> {
    const parser = new XMLParser();
    const workingMessages = messages.map(message => ({ ...message }));
    const events: TurnEvent[] = [];
    let peakInputTokens = 0;
    const nativeTools = this.buildNativeTools();
    const trace = executionContext?.trace ?? new ExecutionTraceStore(
      `execution-standalone-${Date.now().toString(36)}`,
      'standalone',
      `request-standalone-${Date.now().toString(36)}`
    );
    const scope = executionContext?.scope ?? trace.getRootScope();
    const turnMetadata = (visible: boolean, displayContent?: string) => (
      executionContext
        ? {
            turnId: trace.executionId,
            displayContent,
            visibility: visible ? 'visible' as const : 'hidden' as const
          }
        : {}
    );

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

      this.onExecutionStatus?.({
        phase: 'waiting-model',
        ...this.statusIdentity(scope)
      });
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
        events.push({
          type: 'assistant',
          content: finalReply,
          ...turnMetadata(true, finalReply)
        });
        return { reply: finalReply, messages: workingMessages, events, peakInputTokens };
      }

      // 带调用的原始 assistant 消息必须进入上下文，供下一轮模型理解调用来源。
      const assistantCallContent = response.content || this.serializeCallsAsXml(calls);
      workingMessages.push({ role: 'assistant', content: assistantCallContent });
      events.push({
        type: 'assistant',
        content: assistantCallContent,
        ...turnMetadata(false)
      });

      // 先按模型返回顺序注册所有调用，再并行执行。同一轮的调用完成顺序可以不同，
      // 但回填给模型的消息顺序必须保持稳定，避免历史因网络/工具耗时而漂移。
      const preparedCalls: PreparedComponentCall[] = calls.map(call => {
        const callType = call.type as 'tool' | 'skill' | 'subagent';
        const callName = call.name;
        const argsOrQuestion = call.type === 'tool'
          ? call.args
          : call.type === 'subagent'
            ? call.question
            : undefined;
        const callRecord = trace.beginCall(scope, {
          type: callType,
          name: callName,
          display: this.presenter.presentInvocation({
            type: callType,
            name: callName,
            argsOrQuestion
          })
        });
        const callId = callRecord.callId;

        // 通知前端：正在调用
        this.onExecutionStatus?.({
          phase: 'running-component',
          callType,
          name: callName,
          callId,
          ...this.statusIdentity(scope)
        });
        this.onToolCall?.({
          type: callType,
          name: callName,
          status: 'calling',
          ...this.legacyIdentity(scope, callId)
        });

        return { call, callId, callType, callName, argsOrQuestion };
      });

      const completedCalls = await Promise.all(
        preparedCalls.map(prepared => this.executePreparedCall(
          prepared,
          context,
          scope,
          trace,
          executionContext
        ))
      );
      const cancelled = completedCalls.find(completed => completed.cancellationError);
      if (cancelled) throw cancelled.cancellationError;

      for (const completed of completedCalls) {
        const modelResult = this.truncateForModel(completed.modelContent);
        workingMessages.push({
          role: 'user',
          content: `${completed.call.type} ${completed.call.name} 结果: ${modelResult}`
        });
        events.push({
          type: 'component-result',
          callId: completed.callId,
          callType: completed.callType,
          name: completed.callName,
          status: completed.resultStatus,
          content: modelResult,
          ...turnMetadata(false)
        });
      }
    }

    // 达到最大轮次
    const maxRoundsReply = `达到最大执行轮次（${maxRounds}），任务尚未完成。`;
    workingMessages.push({ role: 'assistant', content: maxRoundsReply });
    events.push({
      type: 'assistant',
      content: maxRoundsReply,
      ...turnMetadata(true, maxRoundsReply)
    });
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

  private statusIdentity(scope: AgentExecutionScope) {
    return {
      executionId: scope.executionId,
      parentCallId: scope.parentCallId,
      agentRunId: scope.agentRunId,
      agentName: scope.agentName,
      agentPath: [...scope.agentPath],
      agentDepth: scope.depth
    };
  }

  private legacyIdentity(scope: AgentExecutionScope, callId: string) {
    return {
      callId,
      ...this.statusIdentity(scope)
    };
  }

  private async executePreparedCall(
    prepared: PreparedComponentCall,
    context: ToolContext,
    scope: AgentExecutionScope,
    trace: ExecutionTraceStore,
    executionContext?: RunTurnExecutionContext
  ): Promise<CompletedComponentCall> {
    const { call, callId, callType, callName, argsOrQuestion } = prepared;
    try {
      let presented;
      if (call.type === 'tool') {
        const rawResult = await this.toolExecutor(call.name, call.args, context);
        presented = this.presenter.presentTool({
          name: call.name,
          args: call.args,
          rawResult
        });
      } else if (call.type === 'skill') {
        presented = this.presenter.presentSkill({
          name: call.name,
          content: await this.skillLoader(call.name)
        });
      } else {
        const answer = executionContext
          ? await this.subagentRunner(
              call.name,
              call.question,
              { callId, scope, trace },
              context.signal
            )
          : await (this.subagentRunner as unknown as (
              name: string,
              question: string,
              signal?: AbortSignal
            ) => Promise<string>)(call.name, call.question, context.signal);
        presented = this.presenter.presentSubagent({
          name: call.name,
          question: call.question,
          answer
        });
      }
      trace.finishCall(callId, {
        status: 'success',
        display: presented.display
      });
      this.onToolCall?.({
        type: callType,
        name: callName,
        status: 'success',
        result: this.truncateResult(presented.display.output ?? ''),
        ...this.legacyIdentity(scope, callId)
      });
      return {
        ...prepared,
        modelContent: presented.modelContent,
        resultStatus: 'success'
      };
    } catch (error: any) {
      const presented = this.presenter.presentError({
        type: callType,
        name: callName,
        error,
        argsOrQuestion
      });
      const message = error?.message || String(error);
      const cancelled = Boolean(context.signal?.aborted);
      trace.finishCall(callId, {
        status: cancelled ? 'cancelled' : 'error',
        display: presented.display,
        error: message
      });
      this.onToolCall?.({
        type: callType,
        name: callName,
        status: 'error',
        error: message,
        ...this.legacyIdentity(scope, callId)
      });
      return {
        ...prepared,
        modelContent: presented.modelContent,
        resultStatus: 'error',
        cancellationError: cancelled ? error : undefined
      };
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
