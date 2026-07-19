import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../../src/webview/App';
import { InputArea } from '../../src/webview/components/InputArea';

const postMessage = jest.fn();
(window as any).vscode = {
  postMessage
};
(global as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
  callback(0);
  return 0;
};

const emptyComponents = {
  tools: [],
  skills: [],
  subagents: []
};

const dispatchWebviewMessage = (data: Record<string, unknown>) => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
};

const HistoryInput = () => {
  const [input, setInput] = useState('未发送草稿');
  return (
    <InputArea
      input={input}
      history={['第一条', '第二条']}
      onInputChange={setInput}
      onSend={jest.fn()}
      onClear={jest.fn()}
      onReload={jest.fn()}
      onCompress={jest.fn()}
      onCancel={jest.fn()}
      isLoading={false}
      models={[{ name: 'GPT' }]}
      activeModel="GPT"
      onModelChange={jest.fn()}
      components={emptyComponents}
    />
  );
};

describe('App Component', () => {
  beforeEach(() => {
    postMessage.mockClear();
  });

  it('renders the polished shell and input area', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.app-shell')).toBeInTheDocument();
    expect(screen.getByLabelText('任务输入')).toBeInTheDocument();
    expect(screen.getByText('就绪')).toBeInTheDocument();
  });

  it('shows waiting, component-running, and completed states', () => {
    render(<App />);

    dispatchWebviewMessage({ type: 'execution-status', phase: 'waiting-model' });
    expect(screen.getAllByText('等待模型响应')).toHaveLength(2);

    dispatchWebviewMessage({
      type: 'execution-status',
      phase: 'running-component',
      callType: 'tool',
      name: 'fileRead'
    });
    expect(screen.getAllByText('工具 fileRead 执行中')).toHaveLength(2);

    dispatchWebviewMessage({ type: 'execution-status', phase: 'completed' });
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.queryByText('工具 fileRead 执行中')).not.toBeInTheDocument();
  });

  it('keeps model data when a partial config update only changes components', () => {
    render(<App />);
    dispatchWebviewMessage({
      type: 'config-loaded',
      configPath: '/workspace/.myagent/settings.json',
      config: {},
      models: [{ name: 'GPT' }],
      activeModel: 'GPT',
      components: emptyComponents
    });
    dispatchWebviewMessage({
      type: 'config-updated',
      config: {},
      components: emptyComponents
    });

    expect(screen.getByLabelText('当前模型')).toHaveValue('GPT');
    expect(screen.getByText('/workspace/.myagent/settings.json')).toBeInTheDocument();
  });

  it('sends actual enabled component names instead of the wildcard setting', () => {
    render(<App />);
    dispatchWebviewMessage({
      type: 'config-loaded',
      config: {
        enabledTools: ['*'],
        enabledSkills: ['*'],
        enabledSubagents: ['*']
      },
      models: [{ name: 'GPT' }],
      activeModel: 'GPT',
      components: {
        tools: [
          { name: 'fileRead', description: 'read', source: 'home', enabled: true },
          { name: 'fileWrite', description: 'write', source: 'home', enabled: false }
        ],
        skills: [],
        subagents: []
      }
    });
    postMessage.mockClear();

    const input = screen.getByLabelText('任务输入');
    fireEvent.change(input, { target: { value: '读取 README' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'execute-task',
      content: '读取 README',
      enabledTools: ['fileRead']
    }));
  });

  it('shows recoverable configuration diagnostics without hiding the import action', () => {
    render(<App />);
    dispatchWebviewMessage({
      type: 'config-loaded',
      config: null,
      models: [],
      components: emptyComponents,
      configErrors: [{
        filePath: '/workspace/.myagent/settings.json',
        fieldPath: 'maxRounds',
        message: '必须是 1 到 100 之间的整数'
      }]
    });

    expect(screen.getByText('配置需要修复')).toBeInTheDocument();
    expect(screen.getByText(/maxRounds/)).toBeInTheDocument();
    expect(screen.getByLabelText('导入配置')).toBeInTheDocument();
  });

  it('turns the send button into a cancel action while a task is running', () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('任务输入'), { target: { value: 'long task' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const executeMessage = postMessage.mock.calls
      .map(call => call[0])
      .find(message => message.type === 'execute-task');
    postMessage.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    expect(postMessage).toHaveBeenCalledWith({
      type: 'cancel-task',
      requestId: executeMessage.requestId
    });
  });
});

describe('InputArea history', () => {
  it('navigates older entries and restores the draft with arrow keys', () => {
    render(<HistoryInput />);
    const input = screen.getByLabelText('任务输入');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('第二条');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('第一条');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('第二条');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('未发送草稿');
  });
});
