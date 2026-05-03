import React, { useRef, useEffect } from 'react';

interface Message {
  role: 'user' | 'agent';
  content: string;
  type?: 'text' | 'tool' | 'code';
}

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  colors: { bg: string; border: string; text: string; secondary: string };
}

export const ChatArea: React.FC<ChatAreaProps> = ({ messages, isLoading, colors }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const styles = {
    container: {
      flex: 1,
      overflow: 'auto' as const,
      padding: '12px',
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '8px',
    },
    message: {
      padding: '8px 12px',
      borderRadius: '6px',
      maxWidth: '85%',
      wordBreak: 'break-word' as const,
      whiteSpace: 'pre-wrap' as const,
    },
    user: {
      alignSelf: 'flex-end' as const,
      backgroundColor: colors.secondary,
    },
    agent: {
      alignSelf: 'flex-start' as const,
      backgroundColor: colors.bg,
    },
    loading: {
      color: '#858585',
      fontStyle: 'italic' as const,
    },
    codeBlock: {
      backgroundColor: '#2d2d2d',
      padding: '8px',
      borderRadius: '4px',
      fontFamily: 'monospace' as const,
      fontSize: '12px',
      overflow: 'auto' as const,
    },
  };

  const renderContent = (content: string) => {
    // 简单的代码块渲染
    const parts = content.split(/(```[\s\S]*?```)/g);
    return parts.map((part, i) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        const code = part.slice(3, -3).trim();
        return <pre key={i} style={styles.codeBlock}><code>{code}</code></pre>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div ref={containerRef} style={styles.container}>
      {messages.map((msg, i) => (
        <div
          key={i}
          style={{
            ...styles.message,
            ...(msg.role === 'user' ? styles.user : styles.agent),
            border: `1px solid ${colors.border}`
          }}
        >
          {msg.type === 'tool' && <span>🔧 </span>}
          {renderContent(msg.content)}
        </div>
      ))}
      {isLoading && <div style={styles.loading}>思考中...</div>}
    </div>
  );
};
