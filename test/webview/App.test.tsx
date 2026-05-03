import React from 'react';
import { render } from '@testing-library/react';
import { App } from '../../src/webview/App';

// Mock vscode API
(global as any).vscode = {
  postMessage: jest.fn()
};

describe('App Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should render without crashing', () => {
    render(<App />);
  });

  it('should render header and input area', () => {
    const { container } = render(<App />);
    expect(container.querySelector('div[style*="display: flex"]')).toBeTruthy();
  });
});
