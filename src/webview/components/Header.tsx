import React from 'react';

interface HeaderProps {
  configPath: string;
  onImport: () => void;
}

export const Header: React.FC<HeaderProps> = ({ configPath, onImport }) => {
  const styles = {
    container: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      padding: '8px 12px',
      borderBottom: '1px solid #3C3C3C',
    },
    title: {
      fontSize: '14px',
      fontWeight: 600,
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '6px',
    },
    right: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '8px',
    },
    path: {
      fontSize: '11px',
      color: '#858585',
      maxWidth: '150px',
      overflow: 'hidden' as const,
      textOverflow: 'ellipsis' as const,
      whiteSpace: 'nowrap' as const,
    },
    button: {
      background: 'none',
      border: 'none',
      cursor: 'pointer' as const,
      fontSize: '14px',
      padding: '4px',
      color: '#CCCCCC',
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.title}>
        <span>🤖</span>
        <span>MyAgent</span>
      </div>
      <div style={styles.right}>
        <span style={styles.path} title={configPath}>
          {configPath || '未加载配置'}
        </span>
        <button style={styles.button} onClick={onImport} title="导入配置">
          📁
        </button>
      </div>
    </div>
  );
};
