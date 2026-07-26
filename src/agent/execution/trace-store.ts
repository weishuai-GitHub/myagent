import { ExecutionIdFactory, RandomExecutionIdFactory } from './id-factory';
import {
  AgentExecutionScope,
  ComponentCallCallback,
  ComponentCallRecord,
  ComponentCallStatus,
  ComponentDisplay,
  ComponentCallType,
  ExecutionTraceSnapshot,
  ExecutionTraceStatus
} from './types';

export class ExecutionTraceStore {
  private readonly calls = new Map<string, ComponentCallRecord>();
  private readonly startedAt = Date.now();
  private readonly rootScope: AgentExecutionScope;
  private status: ExecutionTraceStatus = 'running';
  private completedAt?: number;
  private error?: string;
  private nextSequence = 0;

  constructor(
    readonly executionId: string,
    private readonly sessionId: string,
    private readonly requestId: string,
    private readonly onCall?: ComponentCallCallback,
    private readonly idFactory: ExecutionIdFactory = new RandomExecutionIdFactory()
  ) {
    this.rootScope = {
      executionId,
      agentRunId: idFactory.createAgentRunId(),
      agentName: 'main',
      agentPath: ['main'],
      depth: 0
    };
  }

  getRootScope(): AgentExecutionScope {
    return this.cloneScope(this.rootScope);
  }

  beginCall(
    scope: AgentExecutionScope,
    input: {
      type: ComponentCallType;
      name: string;
      display: ComponentDisplay;
    }
  ): ComponentCallRecord {
    this.assertRunning();
    this.assertScope(scope);
    if (scope.parentCallId && !this.calls.has(scope.parentCallId)) {
      throw new Error(`Unknown parent call: ${scope.parentCallId}`);
    }
    const call: ComponentCallRecord = {
      callId: this.idFactory.createCallId(),
      executionId: this.executionId,
      parentCallId: scope.parentCallId,
      agentRunId: scope.agentRunId,
      agentName: scope.agentName,
      agentPath: [...scope.agentPath],
      agentDepth: scope.depth,
      type: input.type,
      name: input.name,
      status: 'calling',
      startedAt: Date.now(),
      display: this.cloneDisplay(input.display),
      sequence: this.nextSequence++
    };
    this.calls.set(call.callId, call);
    this.emit(call);
    return this.cloneCall(call);
  }

  finishCall(
    callId: string,
    result: {
      status: Exclude<ComponentCallStatus, 'calling'>;
      display: ComponentDisplay;
      error?: string;
    }
  ): ComponentCallRecord {
    const existing = this.calls.get(callId);
    if (!existing) throw new Error(`Unknown component call: ${callId}`);
    if (existing.status !== 'calling') {
      throw new Error(`Component call already finished: ${callId}`);
    }
    const completedAt = Date.now();
    const updated: ComponentCallRecord = {
      ...existing,
      status: result.status,
      completedAt,
      durationMs: Math.max(0, completedAt - existing.startedAt),
      display: this.cloneDisplay(result.display),
      error: result.error
    };
    this.calls.set(callId, updated);
    this.emit(updated);
    return this.cloneCall(updated);
  }

  createChildAgentScope(
    parentScope: AgentExecutionScope,
    subagentCallId: string,
    subagentName: string
  ): AgentExecutionScope {
    this.assertScope(parentScope);
    const parentCall = this.calls.get(subagentCallId);
    if (!parentCall || parentCall.type !== 'subagent') {
      throw new Error(`Subagent parent call not found: ${subagentCallId}`);
    }
    return {
      executionId: this.executionId,
      agentRunId: this.idFactory.createAgentRunId(),
      agentName: subagentName,
      agentPath: [...parentScope.agentPath, subagentName],
      depth: parentScope.depth + 1,
      parentCallId: subagentCallId
    };
  }

  finishExecution(
    status: Exclude<ExecutionTraceStatus, 'running'>,
    error?: string
  ): ExecutionTraceSnapshot {
    if (this.status !== 'running') return this.getSnapshot();
    const cancelledDisplay = (call: ComponentCallRecord): ComponentDisplay => ({
      ...this.cloneDisplay(call.display),
      output: call.display.output ?? '调用已取消'
    });
    for (const call of this.calls.values()) {
      if (call.status === 'calling') {
        this.finishCall(call.callId, {
          status: 'cancelled',
          display: cancelledDisplay(call),
          error: status === 'error' ? error : undefined
        });
      }
    }
    this.status = status;
    this.completedAt = Date.now();
    this.error = error;
    return this.getSnapshot();
  }

  getSnapshot(): ExecutionTraceSnapshot {
    return {
      version: 1,
      executionId: this.executionId,
      sessionId: this.sessionId,
      requestId: this.requestId,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error,
      calls: [...this.calls.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map(call => this.cloneCall(call))
    };
  }

  private emit(call: ComponentCallRecord): void {
    this.onCall?.(this.cloneCall(call));
  }

  private assertRunning(): void {
    if (this.status !== 'running') {
      throw new Error(`Execution trace is already ${this.status}`);
    }
  }

  private assertScope(scope: AgentExecutionScope): void {
    if (scope.executionId !== this.executionId) {
      throw new Error(`Agent scope belongs to a different execution: ${scope.executionId}`);
    }
  }

  private cloneScope(scope: AgentExecutionScope): AgentExecutionScope {
    return { ...scope, agentPath: [...scope.agentPath] };
  }

  private cloneDisplay(display: ComponentDisplay): ComponentDisplay {
    return { ...display };
  }

  private cloneCall(call: ComponentCallRecord): ComponentCallRecord {
    return {
      ...call,
      agentPath: [...call.agentPath],
      display: this.cloneDisplay(call.display)
    };
  }
}
