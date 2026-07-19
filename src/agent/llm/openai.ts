import { Message, ChatOptions, ChatResponse, ModelConfig } from '../types';
import { LLMClient } from './index';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as os from 'os';
import * as readline from 'readline';
import { LLMRequestError, parseRetryAfterMs, retryLLMCall } from './retry';

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code?: number;
    message?: string;
    data?: any;
  };
}

interface CodexTurnError {
  message?: string;
  codexErrorInfo?: string | Record<string, any> | null;
  additionalDetails?: string | null;
}

interface CodexTurnResult {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

const CODEX_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_DEVELOPER_INSTRUCTIONS = [
  'You are the language-model backend for MyAgent.',
  'Follow the supplied base instructions and conversation transcript.',
  'Do not invoke Codex built-in tools, shell commands, file operations, web search, skills, or subagents.',
  'Return only the next assistant message.',
  'Preserve any XML tool, skill, or subagent call syntax requested by the base instructions.'
].join(' ');

/**
 * 一次性 Codex App Server 客户端。
 *
 * 每次 chat 创建一个 ephemeral thread，并在完成后结束子进程。认证完全交给
 * Codex CLI 管理，因此可以复用 `codex login` 的 ChatGPT 登录，也不会直接读取
 * 或暴露 ~/.codex/auth.json。
 */
class CodexAppServerCall {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly reader: readline.Interface;
  private readonly pending = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private nextRequestId = 0;
  private stderr = '';
  private activeThreadId: string | null = null;
  private streamedContent = '';
  private completedContent = '';
  private usage: CodexTurnResult['usage'];
  private turnResolve?: (value: CodexTurnResult) => void;
  private turnReject?: (error: Error) => void;
  private pendingTurnContent = '';
  private completionTimer?: NodeJS.Timeout;
  private settled = false;

  constructor(command: string) {
    this.process = spawn(command, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.reader = readline.createInterface({ input: this.process.stdout });

    this.reader.on('line', line => this.handleLine(line));
    this.process.stderr.on('data', chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-4000);
    });
    this.process.stdin.on('error', error => {
      this.failAll(this.codexError(
        `Codex App Server stdin 错误: ${error.message}`,
        true
      ));
    });
    this.process.on('error', error => {
      this.failAll(this.codexStartupError(error));
    });
    this.process.on('close', code => {
      if (!this.settled) {
        const suffix = this.stderr.trim() ? `\n${this.stderr.trim()}` : '';
        this.failAll(this.codexError(
          `Codex App Server 提前退出（code=${code ?? 'unknown'}）${suffix}`,
          this.isTransientMessage(suffix)
        ));
      }
    });
  }

  async run(
    model: string,
    messages: Message[],
    options: ChatOptions,
    signal?: AbortSignal
  ): Promise<CodexTurnResult> {
    const onAbort = () => {
      this.failAll(new LLMRequestError('Codex 模型调用已取消', {
        retryable: true,
        code: 'LLM_TIMEOUT',
        cause: signal?.reason
      }));
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      this.failAll(this.codexError(
        `Codex 调用超时（${CODEX_CALL_TIMEOUT_MS / 1000} 秒）`,
        true
      ));
    }, CODEX_CALL_TIMEOUT_MS);

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'myagent_vscode',
          title: 'MyAgent VSCode',
          version: '0.1.0'
        }
      });
      this.notify('initialized', {});

      const threadResponse = await this.request('thread/start', {
        model,
        cwd: os.tmpdir(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        baseInstructions: options.systemPrompt || 'You are a helpful assistant.',
        developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
        config: {
          web_search: 'disabled'
        }
      });

      const threadId = threadResponse?.thread?.id;
      if (!threadId) {
        throw this.codexError('Codex App Server 未返回 thread id', true);
      }
      this.activeThreadId = threadId;

      const completion = new Promise<CodexTurnResult>((resolve, reject) => {
        this.turnResolve = resolve;
        this.turnReject = reject;
      });

      await this.request('turn/start', {
        threadId,
        model,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: false
        },
        input: [{
          type: 'text',
          text: this.buildConversationPrompt(messages),
          text_elements: []
        }]
      });

      return await completion;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      this.dispose();
    }
  }

  private request(method: string, params: any): Promise<any> {
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      try {
        this.send({ method, id, params });
      } catch (error) {
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  private notify(method: string, params: any): void {
    this.send({ method, params });
  }

  private send(message: JsonRpcMessage): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(this.jsonRpcError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method || !message.params) return;
    const params = message.params;
    if (this.activeThreadId && params.threadId && params.threadId !== this.activeThreadId) return;

    switch (message.method) {
      case 'item/agentMessage/delta':
        this.streamedContent += params.delta || '';
        break;
      case 'item/completed':
        if (params.item?.type === 'agentMessage') {
          this.completedContent = params.item.text || '';
        }
        break;
      case 'thread/tokenUsage/updated': {
        const last = params.tokenUsage?.last;
        if (last) {
          this.usage = {
            inputTokens: last.inputTokens || 0,
            outputTokens: last.outputTokens || 0
          };
          // 某些 App Server 版本会在 turn/completed 之后才发送最终 token。
          if (this.pendingTurnContent) this.completeTurn();
        }
        break;
      }
      case 'turn/completed':
        if (params.turn?.status === 'failed') {
          this.failTurn(this.turnError(params.turn?.error, 'Codex turn 失败'));
        } else {
          const content = this.completedContent || this.streamedContent;
          if (!content) {
            this.failTurn(this.codexError('Codex turn 完成但没有返回 assistant 文本', true));
          } else {
            this.pendingTurnContent = content;
            if (this.usage) {
              this.completeTurn();
            } else {
              // 给最终 token notification 一个很短的到达窗口；没有 usage 时仍正常返回文本。
              this.completionTimer = setTimeout(() => this.completeTurn(), 100);
            }
          }
        }
        break;
      case 'error':
        // App Server 会先发送 error(willRetry=true)，然后在同一 turn 内自行重试。
        // 此时不能结束子进程，否则会主动打断它的恢复流程。
        if (params.willRetry === true) {
          console.warn('Codex App Server transient error; waiting for internal retry:', this.formatTurnError(params.error));
          break;
        }
        this.failTurn(this.turnError(params.error, 'Codex App Server 返回错误'));
        break;
    }
  }

  private buildConversationPrompt(messages: Message[]): string {
    return [
      '下面是按时间顺序排列的对话记录（JSON）。请生成下一条 assistant 消息：',
      JSON.stringify(messages)
    ].join('\n');
  }

  private completeTurn(): void {
    if (this.settled || !this.pendingTurnContent) return;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.settled = true;
    this.turnResolve?.({
      content: this.pendingTurnContent,
      usage: this.usage
    });
  }

  private failTurn(error: Error): void {
    if (this.settled) return;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.settled = true;
    this.turnReject?.(error);
  }

  private failAll(error: Error): void {
    if (this.settled) return;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.settled = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.turnReject?.(error);
  }

  private jsonRpcError(error: NonNullable<JsonRpcMessage['error']>): Error {
    const data = error.data === undefined ? '' : `；data=${this.safeDetail(error.data)}`;
    return new LLMRequestError(
      `Codex JSON-RPC 错误（code=${error.code ?? 'unknown'}）：${error.message || '未知错误'}${data}`,
      {
        // 标准 JSON-RPC 协议/参数错误重试不会改变结果；服务端自定义错误再按文本判断。
        retryable: error.code !== undefined &&
          error.code >= -32099 &&
          error.code <= -32000 &&
          this.isTransientMessage(`${error.message || ''} ${data}`)
      }
    );
  }

  private turnError(error: CodexTurnError | string | undefined, prefix: string): Error {
    const detail = this.formatTurnError(error);
    const info = typeof error === 'object' && error ? error.codexErrorInfo : null;
    const classification = this.classifyCodexError(info, detail);
    const loginHint = classification.authError
      ? '。Codex 登录可能已失效，请运行 `codex login status`，必要时重新执行 `codex login`'
      : '';
    return new LLMRequestError(`${prefix}：${detail}${loginHint}`, {
      retryable: classification.retryable,
      status: classification.status
    });
  }

  private classifyCodexError(
    info: CodexTurnError['codexErrorInfo'],
    detail: string
  ): { retryable: boolean; authError: boolean; status?: number } {
    if (typeof info === 'string') {
      if (['serverOverloaded', 'internalServerError'].includes(info)) {
        return { retryable: true, authError: false };
      }
      if (info === 'unauthorized') {
        return { retryable: false, authError: true, status: 401 };
      }
      if ([
        'contextWindowExceeded',
        'sessionBudgetExceeded',
        'usageLimitExceeded',
        'cyberPolicy',
        'badRequest',
        'threadRollbackFailed',
        'sandboxError'
      ].includes(info)) {
        return { retryable: false, authError: false };
      }
    }

    if (info && typeof info === 'object') {
      const retryableVariants = [
        'httpConnectionFailed',
        'responseStreamConnectionFailed',
        'responseStreamDisconnected',
        'responseTooManyFailedAttempts'
      ];
      for (const variant of retryableVariants) {
        if (Object.prototype.hasOwnProperty.call(info, variant)) {
          const status = Number((info as any)[variant]?.httpStatusCode);
          return {
            retryable: !Number.isFinite(status) || status === 408 || status === 429 || status >= 500,
            authError: status === 401 || status === 403,
            status: Number.isFinite(status) ? status : undefined
          };
        }
      }
    }

    const authError = /unauthorized|authentication|not logged in|login required|登录.*失效/i.test(detail);
    return {
      retryable: !authError && this.isTransientMessage(detail),
      authError
    };
  }

  private formatTurnError(error: CodexTurnError | string | undefined): string {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    const parts = [
      error.message || '未知错误',
      error.codexErrorInfo ? `类型=${this.safeDetail(error.codexErrorInfo)}` : '',
      error.additionalDetails ? `详情=${error.additionalDetails}` : ''
    ].filter(Boolean);
    return parts.join('；');
  }

  private codexStartupError(error: Error): Error {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT|not found/i.test(error.message);
    const hint = missing
      ? '。请安装 Codex CLI，或在模型配置中设置正确的 codexCommand'
      : '';
    return new LLMRequestError(`无法启动 Codex CLI: ${error.message}${hint}`, {
      retryable: !missing,
      code: (error as NodeJS.ErrnoException).code,
      cause: error
    });
  }

  private codexError(message: string, retryable: boolean): Error {
    return new LLMRequestError(message, { retryable });
  }

  private isTransientMessage(message: string): boolean {
    return /timeout|timed out|temporar|connection|network|socket|reset|overload|unavailable|internal server|429|5\d\d/i
      .test(message);
  }

  private safeDetail(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private dispose(): void {
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.reader.close();
    this.process.stdin.end();
    if (!this.process.killed) this.process.kill();
  }
}

export class OpenAIClient implements LLMClient {
  private config: ModelConfig;
  private modelName: string;

  constructor(config: ModelConfig) {
    this.config = config;
    this.modelName = config.model;
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    return retryLLMCall(
      signal => this.chatOnce(messages, options, signal),
      this.config.retry
    );
  }

  private async chatOnce(
    messages: Message[],
    options: ChatOptions,
    signal: AbortSignal
  ): Promise<ChatResponse> {
    if (this.config.auth === 'codex') {
      const call = new CodexAppServerCall(this.config.codexCommand || 'codex');
      const result = await call.run(this.modelName, messages, options, signal);
      return {
        content: result.content,
        stopReason: 'stop',
        usage: result.usage
      };
    }

    if (!this.config.apiKey) {
      throw new Error('OpenAI API key 未配置；如需使用 Codex 登录，请设置 auth: "codex"');
    }
    if (!this.config.baseUrl) {
      throw new Error('OpenAI baseUrl 未配置');
    }

    const formattedMessages: { role: string; content: string }[] = [];

    if (options.systemPrompt) {
      formattedMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role !== 'system') {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.modelName,
        messages: formattedMessages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature || 1.0
      }),
      signal
    });

    if (!response.ok) {
      const error = await response.text();
      throw new LLMRequestError(
        `OpenAI API error: ${response.status} - ${error}`,
        {
          status: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after'))
        }
      );
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      stopReason: data.choices?.[0]?.finish_reason || 'stop',
      usage: data.usage ? {
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0
      } : undefined
    };
  }

  switchModel(modelName: string): void {
    this.modelName = modelName;
  }

  getModelName(): string {
    return this.modelName;
  }
}
