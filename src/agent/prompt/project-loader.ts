import * as path from 'path';
import { readMarkdownPrompt } from './file-loader';

export const PROJECT_DEFINITION_FILE = 'PROJECT.md';

/**
 * 项目定义属于当前 workspace 根目录，不放入可移植的 .myagent 配置目录，
 * 也不向 home、父目录或子目录递归查找。
 */
export function loadProjectPrompt(workspaceDir: string | null): string {
  if (!workspaceDir) return '';
  return readMarkdownPrompt(
    path.join(workspaceDir, PROJECT_DEFINITION_FILE)
  );
}
