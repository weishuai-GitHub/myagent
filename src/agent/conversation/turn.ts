let nextTurnSequence = 0;

function createRequestId(): string {
  nextTurnSequence += 1;
  return `turn-${Date.now().toString(36)}-${nextTurnSequence.toString(36)}`;
}

/**
 * 管理 Session 的单活动 Turn 不变量。默认并发策略是立即拒绝第二个请求，
 * requestId 后续也用于 Webview 事件关联与取消。
 */
export class TurnCoordinator {
  private activeRequestId: string | null = null;

  begin(requestId?: string): string {
    if (this.activeRequestId) {
      throw new Error(
        `当前会话已有任务正在执行（requestId=${this.activeRequestId}），请等待本次执行结束后重试`
      );
    }
    this.activeRequestId = requestId?.trim() || createRequestId();
    return this.activeRequestId;
  }

  finish(requestId: string): void {
    if (this.activeRequestId !== requestId) {
      throw new Error(`Turn requestId 不匹配: ${requestId}`);
    }
    this.activeRequestId = null;
  }

  get activeId(): string | null {
    return this.activeRequestId;
  }
}
