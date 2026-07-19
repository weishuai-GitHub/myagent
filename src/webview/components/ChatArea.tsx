import React, { useEffect, useRef } from 'react';
import { getRunStatusLabel, RunStatus, ToolCallStatus, UIMessage } from '../types';

interface ChatAreaProps {
  messages: UIMessage[];
  runStatus: RunStatus;
}

export const ChatArea: React.FC<ChatAreaProps> = ({ messages, runStatus }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isRunning = runStatus.phase === 'waiting-model' || runStatus.phase === 'running-component';

  useEffect(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, runStatus]);

  const renderContent = (content: string) => {
    const parts = content.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        const firstLineEnd = part.indexOf('\n');
        const code = firstLineEnd > 3
          ? part.slice(firstLineEnd + 1, -3).trim()
          : part.slice(3, -3).trim();
        return <pre key={index} className="code-block"><code>{code}</code></pre>;
      }
      return <React.Fragment key={index}>{part}</React.Fragment>;
    });
  };

  const toolLabel = (status: ToolCallStatus) => {
    const type = status.type === 'tool' ? '工具' : status.type === 'skill' ? '技能' : '子代理';
    const state = status.status === 'calling' ? '执行中' : status.status === 'success' ? '已完成' : '失败';
    return `${type} · ${status.name} · ${state}`;
  };

  return (
    <main ref={containerRef} className="chat-scroll">
      {messages.length === 0 && !isRunning ? (
        <div className="empty-state">
          <div className="empty-state-card">
            <div className="empty-state-icon" aria-hidden="true">A</div>
            <h2>准备好开始了</h2>
            <p>描述你要完成的任务，或输入 / 选择工具、技能与子代理。使用 ↑↓ 可查看历史输入。</p>
          </div>
        </div>
      ) : (
        <div className="chat-list">
          {messages.map((message, index) => {
            const isTool = message.type === 'tool' && message.toolCallStatus;
            return (
              <article
                key={index}
                className={`message-row ${message.role} ${message.type === 'error' ? 'error' : ''}`}
              >
                <div className="message-meta">
                  <span className="message-avatar" aria-hidden="true">
                    {message.role === 'user' ? '你' : 'A'}
                  </span>
                  <span>{isTool ? toolLabel(message.toolCallStatus!) : message.role === 'user' ? '你' : 'MyAgent'}</span>
                </div>
                <div
                  className={`message-card ${isTool ? 'tool-event' : ''}`}
                  data-status={message.toolCallStatus?.status}
                >
                  {isTool && <div className="tool-event-title">{message.content.split('\n')[0]}</div>}
                  {renderContent(isTool ? message.content.split('\n').slice(1).join('\n') : message.content)}
                </div>
              </article>
            );
          })}

          {isRunning && (
            <div className="activity-card" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span>{getRunStatusLabel(runStatus)}</span>
            </div>
          )}
        </div>
      )}
    </main>
  );
};
