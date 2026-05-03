import React from 'react';

export const SimpleApp: React.FC = () => {
  return (
    <div style={{
      height: '100vh',
      width: '100%',
      padding: '20px',
      fontFamily: 'system-ui'
    }}>
      <h1 style={{ color: '#3794FF', marginTop: 0 }}>
        🤖 MyAgent
      </h1>
      <p style={{ color: '#333' }}>欢迎使用 MyAgent VSCode 插件</p>
      <div style={{ marginTop: '20px' }}>
        <button
          style={{
            padding: '8px 16px',
            backgroundColor: '#3794FF',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px'
          }}
          onClick={() => {
            const vscode = (window as any).vscode;
            vscode?.postMessage({ type: 'test-message' });
          }}
        >
          测试连接
        </button>
      </div>
      <div style={{
        marginTop: '20px',
        padding: '10px',
        backgroundColor: '#f5f5f5',
        borderRadius: '4px',
        fontSize: '12px',
        color: '#666'
      }}>
        <strong>配置状态:</strong>
        <ul style={{ marginTop: '10px', paddingLeft: '20px' }}>
          <li>插件版本: 0.1.0</li>
          <li>React 版本: 18.2.0</li>
          <li>状态: 已加载</li>
        </ul>
      </div>
    </div>
  );
};
