export type ComponentCallType = 'tool' | 'skill' | 'subagent';
export type ComponentCallStatus = 'calling' | 'success' | 'error' | 'cancelled';
export type ExecutionTraceStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface ComponentDisplay {
  title: string;
  subtitle?: string;
  input?: string;
  output?: string;
  format: 'text' | 'json' | 'markdown' | 'code';
  truncated?: boolean;
}

export interface ComponentExecutionResult {
  modelContent: string;
  display: ComponentDisplay;
}

export interface AgentExecutionScope {
  executionId: string;
  agentRunId: string;
  agentName: string;
  agentPath: string[];
  depth: number;
  parentCallId?: string;
}

export interface ComponentCallRecord {
  callId: string;
  executionId: string;
  parentCallId?: string;
  agentRunId: string;
  agentName: string;
  agentPath: string[];
  agentDepth: number;
  type: ComponentCallType;
  name: string;
  status: ComponentCallStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  display: ComponentDisplay;
  error?: string;
  sequence: number;
}

export interface ExecutionTraceSnapshot {
  version: 1;
  executionId: string;
  sessionId: string;
  requestId: string;
  status: ExecutionTraceStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  calls: ComponentCallRecord[];
}

export interface RunTurnExecutionContext {
  scope: AgentExecutionScope;
  trace: import('./trace-store').ExecutionTraceStore;
}

export interface SubagentInvocationContext {
  callId: string;
  scope: AgentExecutionScope;
  trace: import('./trace-store').ExecutionTraceStore;
}

export type ComponentCallCallback = (call: ComponentCallRecord) => void;
export type ExecutionTraceCallback = (trace: ExecutionTraceSnapshot) => void;
