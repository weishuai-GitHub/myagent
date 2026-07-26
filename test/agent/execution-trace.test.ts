import { ComponentResultPresenter } from '../../src/agent/execution/component-presenter';
import { ExecutionIdFactory } from '../../src/agent/execution/id-factory';
import { ExecutionTraceStore } from '../../src/agent/execution/trace-store';

class SequentialIds implements ExecutionIdFactory {
  private call = 0;
  private agent = 0;

  createCallId(): string {
    this.call += 1;
    return `call-${this.call}`;
  }

  createAgentRunId(): string {
    this.agent += 1;
    return `agent-${this.agent}`;
  }
}

describe('ExecutionTraceStore', () => {
  it('builds a nested main → subagent → tool call tree', () => {
    const changes: string[] = [];
    const trace = new ExecutionTraceStore(
      'execution-1',
      'session-1',
      'request-1',
      call => changes.push(`${call.callId}:${call.status}`),
      new SequentialIds()
    );
    const presenter = new ComponentResultPresenter();
    const root = trace.getRootScope();
    const subagent = trace.beginCall(root, {
      type: 'subagent',
      name: 'reviewer',
      display: presenter.presentInvocation({
        type: 'subagent',
        name: 'reviewer',
        argsOrQuestion: '检查实现'
      })
    });
    const child = trace.createChildAgentScope(root, subagent.callId, 'reviewer');
    const tool = trace.beginCall(child, {
      type: 'tool',
      name: 'fileRead',
      display: presenter.presentInvocation({
        type: 'tool',
        name: 'fileRead',
        argsOrQuestion: { path: 'src/index.ts' }
      })
    });
    trace.finishCall(tool.callId, {
      status: 'success',
      display: presenter.presentTool({
        name: 'fileRead',
        args: { path: 'src/index.ts' },
        rawResult: 'contents'
      }).display
    });
    trace.finishCall(subagent.callId, {
      status: 'success',
      display: presenter.presentSubagent({
        name: 'reviewer',
        question: '检查实现',
        answer: '没有问题'
      }).display
    });

    const snapshot = trace.finishExecution('completed');
    expect(snapshot.calls).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        parentCallId: undefined,
        agentName: 'main',
        agentPath: ['main'],
        status: 'success'
      }),
      expect.objectContaining({
        callId: 'call-2',
        parentCallId: 'call-1',
        agentName: 'reviewer',
        agentPath: ['main', 'reviewer'],
        status: 'success'
      })
    ]);
    expect(changes).toEqual([
      'call-1:calling',
      'call-2:calling',
      'call-2:success',
      'call-1:success'
    ]);
  });

  it('redacts sensitive object fields from display without changing model content', () => {
    const presenter = new ComponentResultPresenter();
    const result = presenter.presentTool({
      name: 'http',
      args: { authorization: 'Bearer secret', url: 'https://example.test' },
      rawResult: { token: 'secret-token', ok: true }
    });

    expect(result.modelContent).toContain('secret-token');
    expect(result.display.input).toContain('[REDACTED]');
    expect(result.display.input).not.toContain('Bearer secret');
    expect(result.display.output).not.toContain('secret-token');
  });
});
