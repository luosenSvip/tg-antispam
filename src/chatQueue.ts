import { Context, type MiddlewareFn } from "grammy";
import type { Update } from "grammy/types";

interface SessionLane {
  running: boolean;
  waiters: Array<() => void>;
}

export interface SessionSerialOptions {
  maxPendingPerSession?: number;
  maxPendingGlobal?: number;
}

export function getUpdateSessionKey(ctx: Context): string {
  const chatId = ctx.chat?.id;
  if (typeof chatId === "number" && Number.isFinite(chatId)) {
    return `chat:${chatId}`;
  }

  const fromId = ctx.from?.id;
  if (typeof fromId === "number" && Number.isFinite(fromId)) {
    return `user:${fromId}`;
  }

  const updateId = Number((ctx.update as any)?.update_id || 0);
  if (Number.isFinite(updateId) && updateId > 0) {
    return `update:${updateId}`;
  }

  return "global:fallback";
}

export function createSessionSerialMiddleware(
  options: SessionSerialOptions = {}
): MiddlewareFn<Context> {
  const maxPendingPerSession = Math.max(1, Math.floor(options.maxPendingPerSession ?? 400));
  const maxPendingGlobal = Math.max(1, Math.floor(options.maxPendingGlobal ?? 6000));
  const lanes = new Map<string, SessionLane>();
  let pendingGlobal = 0;

  async function acquire(sessionKey: string): Promise<SessionLane> {
    let lane = lanes.get(sessionKey);
    if (!lane) {
      lane = { running: false, waiters: [] };
      lanes.set(sessionKey, lane);
    }

    if (!lane.running) {
      lane.running = true;
      return lane;
    }

    if (lane.waiters.length >= maxPendingPerSession) {
      throw new Error(`session queue overflow: ${sessionKey}`);
    }
    if (pendingGlobal >= maxPendingGlobal) {
      throw new Error("global queue overflow");
    }

    pendingGlobal += 1;
    await new Promise<void>((resolve) => {
      lane!.waiters.push(resolve);
    });
    pendingGlobal -= 1;
    return lane;
  }

  function release(sessionKey: string, lane: SessionLane): void {
    const next = lane.waiters.shift();
    if (next) {
      next();
      return;
    }
    lanes.delete(sessionKey);
  }

  return async (ctx, next) => {
    const sessionKey = getUpdateSessionKey(ctx);
    const lane = await acquire(sessionKey);
    try {
      await next();
    } finally {
      release(sessionKey, lane);
    }
  };
}

export interface UpdateIngressQueueOptions {
  workerCount?: number;
  maxQueueSize?: number;
}

export interface UpdateIngressQueue {
  enqueue(update: Update): boolean;
  getStats(): { queued: number; activeWorkers: number; dropped: number };
}

export function createUpdateIngressQueue(
  handler: (update: Update) => Promise<void>,
  options: UpdateIngressQueueOptions = {}
): UpdateIngressQueue {
  const workerCount = Math.max(1, Math.floor(options.workerCount ?? 8));
  const maxQueueSize = Math.max(100, Math.floor(options.maxQueueSize ?? 10000));

  const queue: Update[] = [];
  let activeWorkers = 0;
  let dropped = 0;

  const pump = () => {
    while (activeWorkers < workerCount && queue.length > 0) {
      const nextUpdate = queue.shift()!;
      activeWorkers += 1;
      void handler(nextUpdate)
        .catch((error) => {
          console.error("[WebhookQueue] 处理 update 失败:", error);
        })
        .finally(() => {
          activeWorkers -= 1;
          pump();
        });
    }
  };

  return {
    enqueue(update: Update): boolean {
      if (queue.length >= maxQueueSize) {
        dropped += 1;
        return false;
      }
      queue.push(update);
      pump();
      return true;
    },
    getStats() {
      return {
        queued: queue.length,
        activeWorkers,
        dropped,
      };
    },
  };
}
