import React from 'react';
import {
  ComponentCallRecord,
  ExecutionTraceSnapshot
} from '../../agent/execution/types';

interface CallTreeProps {
  trace: ExecutionTraceSnapshot;
}

const statusLabel: Record<ComponentCallRecord['status'], string> = {
  calling: '执行中',
  success: '已完成',
  error: '失败',
  cancelled: '已取消'
};

const executionLabel: Record<ExecutionTraceSnapshot['status'], string> = {
  running: '执行中',
  completed: '已完成',
  error: '失败',
  cancelled: '已取消'
};

export const CallTree: React.FC<CallTreeProps> = ({ trace }) => {
  if (trace.calls.length === 0 && trace.status !== 'running') return null;

  const childrenByParent = new Map<string | undefined, ComponentCallRecord[]>();
  for (const call of [...trace.calls].sort((left, right) => left.sequence - right.sequence)) {
    const children = childrenByParent.get(call.parentCallId) ?? [];
    children.push(call);
    childrenByParent.set(call.parentCallId, children);
  }

  const renderCall = (call: ComponentCallRecord): React.ReactNode => {
    const children = childrenByParent.get(call.callId) ?? [];
    const display = call.display;
    const hasDetails = Boolean(
      display.subtitle || display.input || display.output || call.error || children.length
    );
    return (
      <li className="call-tree-node" key={call.callId}>
        <details open={call.status === 'calling' || call.status === 'error'}>
          <summary className="call-tree-summary">
            <span className="call-tree-connector" aria-hidden="true" />
            <span className="call-tree-title">{display.title}</span>
            <span className="call-tree-agent">{call.agentPath.join(' › ')}</span>
            <span className="call-tree-status" data-status={call.status}>
              {statusLabel[call.status]}
            </span>
          </summary>
          {hasDetails && (
            <div className="call-tree-details">
              {display.subtitle && <p className="call-tree-subtitle">{display.subtitle}</p>}
              {display.input && (
                <div className="call-tree-field">
                  <span>输入</span>
                  <pre>{display.input}</pre>
                </div>
              )}
              {display.output && (
                <div className="call-tree-field">
                  <span>输出</span>
                  <pre data-format={display.format}>{display.output}</pre>
                </div>
              )}
              {call.error && !display.output && (
                <div className="call-tree-field error">
                  <span>错误</span>
                  <pre>{call.error}</pre>
                </div>
              )}
              {display.truncated && <div className="call-tree-truncated">展示内容已截断</div>}
              {children.length > 0 && (
                <ol className="call-tree-children">
                  {children.map(renderCall)}
                </ol>
              )}
            </div>
          )}
        </details>
      </li>
    );
  };

  const roots = childrenByParent.get(undefined) ?? [];
  return (
    <section className="call-tree-card" aria-label="Agent 调用树">
      <header className="call-tree-header">
        <span>调用过程</span>
        <span data-status={trace.status}>{executionLabel[trace.status]}</span>
      </header>
      {roots.length > 0 ? (
        <ol className="call-tree-roots">{roots.map(renderCall)}</ol>
      ) : (
        <div className="call-tree-empty">正在等待模型选择组件…</div>
      )}
    </section>
  );
};
