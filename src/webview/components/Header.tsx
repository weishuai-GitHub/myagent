import React from 'react';
import { getRunStatusLabel, RunStatus } from '../types';

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface HeaderProps {
  configPath: string;
  tokenUsage: TokenUsage;
  runStatus: RunStatus;
  onImport: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  configPath,
  tokenUsage,
  runStatus,
  onImport
}) => (
  <header className="topbar">
    <div className="brand-block">
      <div className="brand-mark" aria-hidden="true">MA</div>
      <div className="brand-copy">
        <div className="brand-title">MyAgent</div>
        <div className="config-path" title={configPath}>
          {configPath || '尚未加载配置'}
        </div>
      </div>
    </div>

    <div className="topbar-actions">
      <div
        className="status-pill"
        data-phase={runStatus.phase}
        title={runStatus.detail || getRunStatusLabel(runStatus)}
        role="status"
        aria-live="polite"
      >
        <span className="status-dot" aria-hidden="true" />
        <span>{getRunStatusLabel(runStatus)}</span>
      </div>
      <div
        className="token-meter"
        title={`输入 ${tokenUsage.inputTokens}，输出 ${tokenUsage.outputTokens}`}
      >
        <span>Tokens</span>
        <strong>{tokenUsage.totalTokens.toLocaleString()}</strong>
      </div>
      <button className="icon-button" onClick={onImport} title="导入配置" aria-label="导入配置">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 7.5h7l2-2h9v13H3v-11Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M12 10v6m-3-3h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  </header>
);
