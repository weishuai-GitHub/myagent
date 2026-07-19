import * as vscode from 'vscode';
import { AgentRuntime } from './runtime';
import { ComponentRegistry } from './component/registry';
import { MessageManager } from './message/MessageManager';
import {
  AgentExecutor,
  ToolCallCallback,
  TokenUsageCallback,
  CompressCallback,
  ExecutionStatusCallback
} from './executor';
import { executeTool } from './component/tools/executor';
import { getSkillContent } from './component/skills/loader';
import { extractToolDescription, ToolApprovalRequest } from './component/tools/types';
import { extractSkillDescription } from './component/skills/types';
import { extractSubagentDescription } from './component/subagents/types';
import { ToolContext, Tool, Skill, Subagent } from './component/types';
import { createSummarizeFn } from './message/summarizer';
import { Message } from './types';
import { ConversationSnapshot } from './conversation/types';
import { TurnCoordinator } from './conversation/turn';
import { TokenUsage } from './types';

export interface SessionOptions {
  callbacks?: {
    onToolCall?: ToolCallCallback;
    onTokenUsage?: TokenUsageCallback;
    onCompress?: CompressCallback;
    onExecutionStatus?: ExecutionStatusCallback;
  };
  enabledTools?: string[];
  enabledSkills?: string[];
  enabledSubagents?: string[];
  maxRounds?: number;
  /** 工具权限确认入口；FloatingPanelProvider 会注入带 workspaceState 持久化的实现。 */
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
  /** 覆盖 registry.agentPrompt，用于 subagent 派生时指定子代理自己的 prompt */
  agentPromptOverride?: string;
}

/**
 * Session：一次会话生命周期内的状态容器。
 *
 * 负责：
 * - 持有 MessageManager（系统提示词 / 组件描述 / 对话历史 / token 累计）
 * - 持有 AgentExecutor，并将 SessionOptions.callbacks 注入到 executor
 * - execute(text)：追加用户消息 → 跑 executor → 追加 assistant 回复；出错时回滚最后一条
 * - reset()：清空历史并复位 token 累计，但保留系统上下文
 * - 内部 runSubagent：通过 runtime.spawnSubagent 派生子 runtime + 子 session 执行
 */
export class Session {
  private readonly messageManager: MessageManager;
  private readonly executor: AgentExecutor;
  private readonly sessionApprovals = new Set<string>();
  private readonly turnCoordinator = new TurnCoordinator();
  private activeController: AbortController | null = null;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly registry: ComponentRegistry,
    private readonly opts: SessionOptions
  ) {
    this.messageManager = new MessageManager();

    // 系统提示词：优先用 opts.agentPromptOverride（subagent 场景），否则取 registry 聚合后的 agentPrompt
    const systemPrompt = opts.agentPromptOverride ?? this.registry.agentPrompt ?? '';
    const components = this.buildComponentDescriptions(
      this.registry.listTools(),
      this.registry.listSkills(),
      this.registry.listSubagents()
    );
    this.messageManager.setSystemContext(systemPrompt, components);

    this.executor = new AgentExecutor(
      this.runtime.client,
      {
        tools: this.registry.listTools(),
        skills: this.registry.listSkills(),
        subagents: this.registry.listSubagents(),
        agentPrompt: systemPrompt
      },
      (name, args, ctx) => executeTool(this.registry.listTools(), name, args, ctx),
      (name) => getSkillContent(this.registry.listSkills(), name),
      (name, question, signal) => this.runSubagent(name, question, signal),
      opts.callbacks?.onToolCall
    );

    // 无论是否注册 UI 回调，都把每次 LLM usage 累加进 Session。
    // 对外回调发送累计值，确保多轮 tool/subagent 调用时界面显示完整用量。
    this.executor.setOnTokenUsage(usage => this.recordTokenUsage(usage));
    if (opts.callbacks?.onExecutionStatus) {
      this.executor.setOnExecutionStatus(opts.callbacks.onExecutionStatus);
    }
  }

  async execute(userText: string, requestId?: string): Promise<string> {
    const activeRequestId = this.turnCoordinator.begin(requestId);
    const controller = new AbortController();
    this.activeController = controller;
    const checkpoint = this.messageManager.createCheckpoint();
    this.messageManager.addUserMessage(userText);
    const ctx: ToolContext = {
      env: this.runtime.config.getEnv(),
      workspaceDir: this.runtime.workspaceDir ?? '',
      availableComponents: this.messageManager.getComponentDescriptions(),
      signal: controller.signal,
      requestApproval: request => this.opts.requestToolApproval
        ? this.opts.requestToolApproval(request)
        : this.requestToolApproval(request)
    };
    try {
      const turnResult = await this.executor.runTurn(
        this.messageManager.getMessages(),
        ctx,
        this.opts.maxRounds ?? this.runtime.getMaxRounds()
      );
      this.messageManager.commitTurnEvents(turnResult.events);
      if (
        this.opts.callbacks?.onCompress &&
        this.messageManager.needsCompression(turnResult.peakInputTokens)
      ) {
        try {
          await this.opts.callbacks.onCompress(turnResult.peakInputTokens);
        } catch (error) {
          if (controller.signal.aborted) {
            throw controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error('任务已取消');
          }
          console.warn(
            'Automatic history compression failed:',
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      return turnResult.reply;
    } catch (e) {
      this.messageManager.rollbackTo(checkpoint);
      throw e;
    } finally {
      this.activeController = null;
      this.turnCoordinator.finish(activeRequestId);
    }
  }

  async compressHistory(): Promise<boolean> {
    const summarize = createSummarizeFn(
      this.runtime.client,
      this.activeController?.signal
    );
    return this.messageManager.compressHistory(summarize);
  }

  /**
   * 清空对话历史，保留 systemPrompt + 组件描述；同时复位累计 token 为 0。
   * clearHistory() 只清 history，不影响 systemPrompt/componentDescriptions。
   */
  reset(): void {
    this.messageManager.clearHistory();
    this.messageManager.resetTokenUsage();
  }

  getTokenUsage() {
    return this.messageManager.getTokenUsage();
  }

  getMessageCount(): number {
    return this.messageManager.getLength();
  }

  cancel(): boolean {
    if (!this.activeController || this.activeController.signal.aborted) return false;
    this.activeController.abort(new Error('用户已取消当前任务'));
    return true;
  }

  getHistorySnapshot(): ConversationSnapshot {
    return this.messageManager.getSnapshot();
  }

  restoreHistory(snapshot: ConversationSnapshot | Message[]): void {
    if (this.turnCoordinator.activeId) {
      throw new Error('任务执行期间不能恢复会话历史');
    }
    if (this.messageManager.getLength() > 0) {
      throw new Error('只能向空 Session 恢复会话历史');
    }
    this.messageManager.restoreHistory(snapshot);
  }

  private async requestToolApproval(request: ToolApprovalRequest): Promise<boolean> {
    const approvalKey = `${request.toolName}:${request.approvalId}`;
    if (this.sessionApprovals.has(approvalKey)) return true;

    const allowOnce = '允许一次';
    const allowAlways = '一直允许';
    const deny = '拒绝';
    const detail = [
      request.reason,
      `工具：${request.toolName}`,
      `参数预览：${request.argsPreview}`
    ].join('\n');
    const selected = await vscode.window.showWarningMessage(
      detail,
      { modal: true },
      allowOnce,
      ...(request.rememberable === false ? [] : [allowAlways]),
      deny
    );
    if (selected === allowAlways) {
      this.sessionApprovals.add(approvalKey);
      return true;
    }
    return selected === allowOnce;
  }

  private async runSubagent(
    name: string,
    question: string,
    parentSignal?: AbortSignal
  ): Promise<string> {
    const sub = this.registry.findSubagent(name);
    if (!sub) throw new Error(`Subagent ${name} not found`);

    const childRuntime = this.runtime.spawnSubagent(sub);
    const childSession = childRuntime.createSession({
      callbacks: {
        onToolCall: this.opts.callbacks?.onToolCall,
        onExecutionStatus: this.opts.callbacks?.onExecutionStatus
      },
      agentPromptOverride: sub.agentPrompt,
      maxRounds: sub.maxRounds,
      requestToolApproval: this.opts.requestToolApproval
    });
    const onParentAbort = () => childSession.cancel();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal?.aborted) onParentAbort();
    try {
      const answer = await childSession.execute(question);
      return `subagent ${name} status: success\nanswer:\n${answer}`;
    } catch (e: any) {
      throw new Error(`subagent ${name} status: error\nerror:\n${e.message}`);
    } finally {
      parentSignal?.removeEventListener('abort', onParentAbort);
      this.recordTokenUsage(childSession.getTokenUsage());
    }
  }

  private recordTokenUsage(usage: TokenUsage): void {
    this.messageManager.addTokenUsage(usage);
    const total = this.messageManager.getTokenUsage();
    this.opts.callbacks?.onTokenUsage?.({
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens
    });
  }

  private buildComponentDescriptions(tools: Tool[], skills: Skill[], subagents: Subagent[]): string {
    const parts: string[] = ['以下是组件列表的详细描述：\n'];
    if (tools.length > 0) parts.push('工具列表:\n' + tools.map(extractToolDescription).join('\n'));
    if (skills.length > 0) parts.push('技能列表:\n' + skills.map(extractSkillDescription).join('\n'));
    if (subagents.length > 0) parts.push('子代理列表:\n' + subagents.map(extractSubagentDescription).join('\n'));
    return parts.join('\n\n');
  }
}
