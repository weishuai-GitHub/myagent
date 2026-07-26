import { randomUUID } from 'crypto';

export interface ExecutionIdFactory {
  createCallId(): string;
  createAgentRunId(): string;
}

export class RandomExecutionIdFactory implements ExecutionIdFactory {
  createCallId(): string {
    return `call-${randomUUID()}`;
  }

  createAgentRunId(): string {
    return `agent-${randomUUID()}`;
  }
}

