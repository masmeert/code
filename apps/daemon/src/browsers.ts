import type { BrowserAction, BrowserResult, ServerFrame } from "@apcode/contracts";

export interface BrowserHost {
  send(frame: ServerFrame): void;
  shows(threadId: string): boolean;
}

interface PendingRequest {
  readonly host: BrowserHost;
  readonly resolve: (result: BrowserResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type Browsers = ReturnType<typeof createBrowsers>;

export function createBrowsers() {
  const hosts = new Set<BrowserHost>();
  const pending = new Map<string, PendingRequest>();

  function take(requestId: string) {
    const request = pending.get(requestId);
    if (!request) return null;
    clearTimeout(request.timer);
    pending.delete(requestId);
    return request;
  }

  return {
    attach(host: BrowserHost) {
      hosts.add(host);
    },
    detach(host: BrowserHost) {
      hosts.delete(host);
      for (const [requestId, request] of pending) {
        if (request.host === host) take(requestId)?.reject(new Error("The APCode window running the browser closed"));
      }
    },
    respond(host: BrowserHost, requestId: string, result: BrowserResult | null, error: string | null) {
      if (pending.get(requestId)?.host !== host) return;
      const request = take(requestId)!;
      if (result) request.resolve(result);
      else request.reject(new Error(error ?? "The browser action failed"));
    },
    request(threadId: string, action: BrowserAction) {
      const candidates = [...hosts];
      const host = candidates.findLast((candidate) => candidate.shows(threadId)) ?? candidates.at(-1);
      if (!host) return Promise.reject(new Error("The browser needs the APCode desktop app to be open"));
      const requestId = crypto.randomUUID();
      return new Promise<BrowserResult>((resolve, reject) => {
        const timer = setTimeout(() => take(requestId)?.reject(new Error("The browser didn't answer in time")), 60_000);
        pending.set(requestId, { host, resolve, reject, timer });
        host.send({ _tag: "browser.request", requestId, threadId, action });
      });
    },
  };
}
