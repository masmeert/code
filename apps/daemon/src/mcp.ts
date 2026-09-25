import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BrowserAction, type BrowserResult } from "@apcode/contracts";
import { z } from "zod";
import { PORT } from "./port.ts";

export type Mcp = ReturnType<typeof createMcp>;

export interface McpServerAccess {
  readonly url: string;
  readonly token: string;
}

function hashOf(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function browserServer(browser: (action: BrowserAction) => Promise<BrowserResult>) {
  async function run(action: BrowserAction) {
    try {
      const result = await browser(action);
      return {
        content: [
          {
            type: "text" as const,
            text: `${result.title || "(untitled)"} — ${result.url}\n\n${result.text}`,
          },
          ...(result.screenshot
            ? [{ type: "image" as const, data: result.screenshot, mimeType: "image/png" }]
            : []),
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
        ],
        isError: true,
      };
    }
  }

  const server = new McpServer(
    { name: "browser", version: "1.0.0" },
    {
      instructions:
        "A real browser the user watches in APCode's Browser panel next to this thread; it shares their logins. Use it to check web apps you build (such as a local dev server) or to read pages. Call snapshot to see the page (text, interactive elements with refs like e3, and a screenshot), then click or type by ref. Refs go stale after navigation or re-renders, so take a new snapshot when an action says nothing matches.",
    },
  );
  const alwaysLoad = { "anthropic/alwaysLoad": true };
  server.registerTool(
    "navigate",
    {
      description:
        "Open a URL in the browser; localhost addresses need no scheme. Opens the Browser panel if it's closed.",
      inputSchema: { url: z.string() },
      _meta: alwaysLoad,
    },
    ({ url }) => run(BrowserAction.cases.navigate.make({ url })),
  );
  server.registerTool(
    "snapshot",
    {
      description:
        "See the current page: URL, title, visible text, interactive elements with refs, and a screenshot.",
      annotations: { readOnlyHint: true },
      _meta: alwaysLoad,
    },
    () => run(BrowserAction.cases.snapshot.make({})),
  );
  server.registerTool(
    "click",
    {
      description:
        "Click an element by ref from the latest snapshot (such as e3) or by CSS selector.",
      inputSchema: { target: z.string() },
      _meta: alwaysLoad,
    },
    ({ target }) => run(BrowserAction.cases.click.make({ target })),
  );
  server.registerTool(
    "type",
    {
      description:
        "Replace the text of an input by ref or CSS selector; set submit to press Enter afterwards.",
      inputSchema: { target: z.string(), text: z.string(), submit: z.boolean().optional() },
      _meta: alwaysLoad,
    },
    ({ target, text, submit }) =>
      run(BrowserAction.cases.type.make({ target, text, submit: submit ?? false })),
  );
  server.registerTool(
    "press",
    {
      description: "Press a key in the page, such as Enter, Tab, Escape, Backspace or ArrowDown.",
      inputSchema: { key: z.string() },
      _meta: alwaysLoad,
    },
    ({ key }) => run(BrowserAction.cases.press.make({ key })),
  );
  server.registerTool(
    "evaluate",
    {
      description: "Run a JavaScript expression in the page and return its JSON value.",
      inputSchema: { expression: z.string() },
      _meta: alwaysLoad,
    },
    ({ expression }) => run(BrowserAction.cases.evaluate.make({ expression })),
  );
  server.registerTool(
    "console",
    {
      description: "Read the page's recent console messages and errors.",
      annotations: { readOnlyHint: true },
      _meta: alwaysLoad,
    },
    () => run(BrowserAction.cases.console.make({})),
  );
  return server;
}

export function createMcp(
  browser: (threadId: string, action: BrowserAction) => Promise<BrowserResult>,
) {
  const threadByTokenHash = new Map<string, string>();
  const tokenHashByThread = new Map<string, string>();

  function revoke(threadId: string) {
    const tokenHash = tokenHashByThread.get(threadId);
    if (tokenHash === undefined) return;
    threadByTokenHash.delete(tokenHash);
    tokenHashByThread.delete(threadId);
  }

  return {
    issue(threadId: string): McpServerAccess {
      revoke(threadId);
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashOf(token);
      threadByTokenHash.set(tokenHash, threadId);
      tokenHashByThread.set(threadId, tokenHash);
      return { url: `http://127.0.0.1:${PORT}/mcp`, token };
    },
    revoke,
    async handle(request: Request) {
      const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/)?.[1];
      const threadId = token ? threadByTokenHash.get(hashOf(token)) : undefined;
      if (threadId === undefined)
        return new Response("A valid bearer token is required", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await browserServer((action) => browser(threadId, action)).connect(transport);
      return transport.handleRequest(request);
    },
  };
}
