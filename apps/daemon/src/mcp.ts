import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  BrowserAction,
  PermissionLevel,
  ProviderKind,
  type BrowserResult,
} from "@apcode/contracts";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { PORT } from "./port.ts";

export type Mcp = ReturnType<typeof createMcp>;

export interface McpServerAccess {
  /** The browser tools; the orchestration tools are at `${url}/apcode`. */
  readonly url: string;
  readonly token: string;
}

const StartThreadInput = {
  prompt: z
    .string()
    .describe("The task, complete: the new thread's agent sees nothing of this conversation."),
  provider: z
    .enum(ProviderKind.literals)
    .optional()
    .describe("Which harness runs it: claude or codex. Yours when left out."),
  model: z.string().optional().describe("The harness's default model when left out."),
  permission: z
    .enum(PermissionLevel.literals)
    .optional()
    .describe(
      "How much it may do without asking: plan, ask, auto-edit, auto or full-access. No more than yours; yours when left out.",
    ),
  worktree: z
    .boolean()
    .optional()
    .describe("Start it in a new git worktree on a branch of its own, instead of your folder."),
  wait: z.boolean().optional().describe("Wait for its answer before returning."),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How long to wait; 600 when left out."),
  requestId: z
    .string()
    .optional()
    .describe(
      "Any id of yours for this request: retrying with it returns the same thread instead of starting another.",
    ),
};

const SendMessageInput = {
  threadId: z.string(),
  text: z.string(),
  queue: z
    .boolean()
    .optional()
    .describe(
      "If its agent is working: wait for its turn to end instead of joining the turn in progress.",
    ),
  permission: z.enum(PermissionLevel.literals).optional().describe("No more than yours."),
  requestId: z.string().optional().describe("Retrying with the same id doesn't send it twice."),
};

const WaitInput = {
  threadId: z.string(),
  timeoutSeconds: z.number().int().positive().optional().describe("600 when left out."),
};

export type StartThreadInput = z.infer<z.ZodObject<typeof StartThreadInput>>;
export type SendMessageInput = z.infer<z.ZodObject<typeof SendMessageInput>>;

/** What the orchestration tools do, for the agent of thread `caller`; failures are messages for that agent. */
export interface Orchestration {
  readonly listThreads: (caller: string) => Effect.Effect<unknown, Error>;
  readonly readThread: (
    caller: string,
    threadId: string,
    after: number | undefined,
  ) => Effect.Effect<unknown, Error>;
  readonly startThread: (caller: string, input: StartThreadInput) => Effect.Effect<unknown, Error>;
  readonly sendMessage: (caller: string, input: SendMessageInput) => Effect.Effect<unknown, Error>;
  readonly waitForThread: (
    caller: string,
    threadId: string,
    timeoutMs: number,
  ) => Effect.Effect<unknown, Error>;
  readonly stopThread: (caller: string, threadId: string) => Effect.Effect<unknown, Error>;
}

const WAIT_MS = 600_000;

function orchestrationServer(caller: string, orchestration: Orchestration) {
  function run(effect: Effect.Effect<unknown, Error>) {
    return Effect.runPromise(
      Effect.match(effect, {
        onSuccess: (result) => ({
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        }),
        onFailure: (error) => ({
          content: [{ type: "text" as const, text: error.message }],
          isError: true,
        }),
      }),
    );
  }
  const server = new McpServer(
    { name: "apcode", version: "1.0.0" },
    {
      instructions:
        "APCode's threads. Start agents (Claude or Codex) in threads of their own to work on tasks in parallel, get a second opinion from the other harness, or review work; message them, wait for and read their answers. Threads you start show in the user's sidebar, in your project, where the user can watch and steer them. Stopping your thread stops them too.",
    },
  );
  const readOnly = { readOnlyHint: true };
  server.registerTool(
    "list_threads",
    {
      description: "Threads in your project, newest first: id, title, harness and status.",
      annotations: readOnly,
    },
    () => run(orchestration.listThreads(caller)),
  );
  server.registerTool(
    "read_thread",
    {
      description:
        "A thread's messages, oldest first. Pass `after` (a message's position) to read only what came since.",
      inputSchema: { threadId: z.string(), after: z.number().int().optional() },
      annotations: readOnly,
    },
    ({ threadId, after }) => run(orchestration.readThread(caller, threadId, after)),
  );
  server.registerTool(
    "start_thread",
    {
      description:
        "Starts an agent on a task in a new thread in your project. Returns its id; with `wait`, also its answer.",
      inputSchema: StartThreadInput,
    },
    (input) => run(orchestration.startThread(caller, input)),
  );
  server.registerTool(
    "send_message",
    {
      description: "Sends a message to a thread: it starts a turn, or joins the one running.",
      inputSchema: SendMessageInput,
    },
    (input) => run(orchestration.sendMessage(caller, input)),
  );
  server.registerTool(
    "wait_for_thread",
    {
      description:
        "Waits until a thread's agent finishes its turn, then returns its status and last answer. A timeout returns the status so far and leaves it working.",
      inputSchema: WaitInput,
      annotations: readOnly,
    },
    ({ threadId, timeoutSeconds }) =>
      run(orchestration.waitForThread(caller, threadId, (timeoutSeconds ?? WAIT_MS / 1000) * 1000)),
  );
  server.registerTool(
    "stop_thread",
    {
      description: "Stops a thread's running turn, and the threads its agent started.",
      inputSchema: { threadId: z.string() },
    },
    ({ threadId }) => run(orchestration.stopThread(caller, threadId)),
  );
  return server;
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
  orchestration: Orchestration,
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
      await (
        new URL(request.url).pathname === "/mcp/apcode"
          ? orchestrationServer(threadId, orchestration)
          : browserServer((action) => browser(threadId, action))
      ).connect(transport);
      return transport.handleRequest(request);
    },
  };
}
