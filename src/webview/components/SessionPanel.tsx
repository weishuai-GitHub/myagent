import React, { useEffect, useState } from 'react';
import { ConversationSessionDto } from '../../protocol/webview';

interface SessionPanelProps {
  open: boolean;
  sessions: ConversationSessionDto[];
  activeSessionId: string;
  disabled: boolean;
  onClose: () => void;
  onCreate: () => void;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
}

const formatUpdatedAt = (timestamp: number): string => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
};

export const SessionPanel: React.FC<SessionPanelProps> = ({
  open,
  sessions,
  activeSessionId,
  disabled,
  onClose,
  onCreate,
  onSelect,
  onRename,
  onDelete
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditingTitle('');
    }
  }, [open]);

  if (!open) return null;

  const beginRename = (session: ConversationSessionDto) => {
    setEditingId(session.id);
    setEditingTitle(session.title);
  };

  const commitRename = () => {
    if (editingId && editingTitle.trim()) {
      onRename(editingId, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle('');
  };

  return (
    <>
      <button
        className="session-backdrop"
        aria-label="关闭会话列表"
        onClick={onClose}
      />
      <aside className="session-panel" aria-label="会话管理">
        <div className="session-panel-header">
          <div>
            <strong>会话</strong>
            <span>{sessions.length} 个当前工作区会话</span>
          </div>
          <button
            className="session-new-button"
            type="button"
            disabled={disabled}
            onClick={onCreate}
          >
            新建
          </button>
        </div>

        <div className="session-list">
          {sessions.map(session => {
            const active = session.id === activeSessionId;
            const editing = session.id === editingId;
            return (
              <div className={`session-item${active ? ' active' : ''}`} key={session.id}>
                {editing ? (
                  <input
                    className="session-title-input"
                    value={editingTitle}
                    maxLength={120}
                    autoFocus
                    onChange={event => setEditingTitle(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={event => {
                      if (event.key === 'Enter') commitRename();
                      if (event.key === 'Escape') {
                        setEditingId(null);
                        setEditingTitle('');
                      }
                    }}
                    aria-label="会话标题"
                  />
                ) : (
                  <button
                    type="button"
                    className="session-item-main"
                    disabled={disabled}
                    onClick={() => onSelect(session.id)}
                    title={session.title}
                  >
                    <span className="session-title">{session.title}</span>
                    <span className="session-meta">
                      {session.messageCount} 条 · {formatUpdatedAt(session.updatedAt)}
                    </span>
                  </button>
                )}

                {!editing && (
                  <div className="session-item-actions">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => beginRename(session)}
                      aria-label={`重命名 ${session.title}`}
                      title="重命名"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        if (window.confirm(`确定删除会话“${session.title}”吗？`)) {
                          onDelete(session.id);
                        }
                      }}
                      aria-label={`删除 ${session.title}`}
                      title="删除"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
};
