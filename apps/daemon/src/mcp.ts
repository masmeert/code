import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  BrowserAction,
  DevicePlatform,
  PermissionLevel,
  ProviderKind,
  type BrowserResult,
} from "@masscode/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { z } from "zod";
import { type Devices, nameAgentSession } from "./devices.ts";
import { PORT } from "./port.ts";
import { getErrorMessage } from "./errors.ts";

export type Mcp = ReturnType<typeof createMcp>;

export interface McpServerAccess {
  /** The browser tools; the orchestration tools are at `${url}/masscode`, the simulator's at `${url}/device`. */
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
    .describe("Which harness runs it; list_harnesses says which are ready. Yours when left out."),
  model: z
    .string()
    .optional()
    .describe(
      "A model id from list_harnesses. Yours when on your harness, else the harness's default.",
    ),
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
  wait: z
    .boolean()
    .optional()
    .describe(
      "Wait for its answer before returning. Without it, or if the wait times out, its answer comes to you as a message once its turn ends.",
    ),
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
  mode: z
    .enum(["auto", "queue", "restart"])
    .optional()
    .describe(
      "If its agent is working: `auto` joins the turn in progress, `queue` waits for the turn to end, `restart` stops the turn (and threads it started) and starts a new one with your message. `auto` when left out.",
    ),
  permission: z.enum(PermissionLevel.literals).optional().describe("No more than yours."),
  requestId: z.string().optional().describe("Retrying with the same id doesn't send it twice."),
};

const AnswerQuestionsInput = {
  threadId: z.string(),
  requestId: z.string().describe("The request the questions came with."),
  answers: z
    .record(z.string(), z.array(z.string()))
    .describe(
      "By question id, the labels of the options picked, or your own answer in their place. Questions left out go unanswered.",
    ),
};

const WatchPullRequestInput = {
  pullRequest: z
    .string()
    .optional()
    .describe("Its URL or number. The pull request of your branch when left out."),
  stop: z.boolean().optional().describe("Stop watching instead."),
};

const WaitInput = {
  threadId: z.string(),
  timeoutSeconds: z.number().int().positive().optional().describe("600 when left out."),
};

export type StartThreadInput = z.infer<z.ZodObject<typeof StartThreadInput>>;

export type SendMessageInput = z.infer<z.ZodObject<typeof SendMessageInput>>;

export type AnswerQuestionsInput = z.infer<z.ZodObject<typeof AnswerQuestionsInput>>;

export type WatchPullRequestInput = z.infer<z.ZodObject<typeof WatchPullRequestInput>>;

/** What the orchestration tools do, for the agent of thread `caller`; failures are messages for that agent. */
interface Orchestration {
  readonly listHarnesses: (caller: string) => Effect.Effect<unknown, Error>;
  readonly listThreads: (caller: string) => Effect.Effect<unknown, Error>;
  readonly readThread: (
    caller: string,
    threadId: string,
    after: number | undefined,
    view: "messages" | "activity" | undefined,
  ) => Effect.Effect<unknown, Error>;
  readonly startThread: (caller: string, input: StartThreadInput) => Effect.Effect<unknown, Error>;
  readonly startThreads: (
    caller: string,
    inputs: ReadonlyArray<StartThreadInput>,
  ) => Effect.Effect<unknown, Error>;
  readonly renameThread: (
    caller: string,
    threadId: string,
    title: string,
  ) => Effect.Effect<unknown, Error>;
  readonly sendMessage: (caller: string, input: SendMessageInput) => Effect.Effect<unknown, Error>;
  readonly answerQuestions: (
    caller: string,
    input: AnswerQuestionsInput,
  ) => Effect.Effect<unknown, Error>;
  readonly watchPullRequest: (
    caller: string,
    input: WatchPullRequestInput,
  ) => Effect.Effect<unknown, Error>;
  readonly waitForThread: (
    caller: string,
    threadId: string,
    timeoutMs: number,
  ) => Effect.Effect<unknown, Error>;
  readonly stopThread: (caller: string, threadId: string) => Effect.Effect<unknown, Error>;
}

const WAIT_MS = 600_000;

function createOrchestrationServer(caller: string, orchestration: Orchestration) {
  function runToolEffect(effect: Effect.Effect<unknown, Error>) {
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
    { name: "masscode", version: "1.0.0" },
    {
      instructions:
        "MassCode's threads. Start agents (Claude, Codex or Cursor; list_harnesses says which are ready, with their models) in threads of their own to work on tasks in parallel, get a second opinion from the other harness, or review work; message them, wait for and read their answers. A thread you start or message reports back to you as a message when its turn ends, unless you were waiting on it, so you can carry on with other work meanwhile. Threads you start show in the user's sidebar, in your project, where the user can watch and steer them. Stopping your thread stops them too. To point the user to a thread, link it as [its title](masscode://thread/<threadId>): MassCode shows that as a link to the thread.",
    },
  );

  const readOnly = { readOnlyHint: true };

  server.registerTool(
    "list_harnesses",
    {
      description:
        "The harnesses you can start threads on (and why any can't run now), with their model ids, and what you run on.",
      annotations: readOnly,
    },
    () => runToolEffect(orchestration.listHarnesses(caller)),
  );

  server.registerTool(
    "list_threads",
    {
      description: "Threads in your project, newest first: id, title, harness and status.",
      annotations: readOnly,
    },
    () => runToolEffect(orchestration.listThreads(caller)),
  );

  server.registerTool(
    "read_thread",
    {
      description:
        "A thread's messages, oldest first; `sentBy` marks user messages another agent or MassCode sent rather than the user. Pass `after` (an item's position) to read only what came since.",
      inputSchema: {
        threadId: z.string(),
        after: z.number().int().optional(),
        view: z
          .enum(["messages", "activity"])
          .optional()
          .describe(
            "`activity` adds its tool calls (with failures), approvals and questions, errors and file changes. `messages` when left out.",
          ),
      },
      annotations: readOnly,
    },
    ({ threadId, after, view }) =>
      runToolEffect(orchestration.readThread(caller, threadId, after, view)),
  );

  server.registerTool(
    "start_thread",
    {
      description:
        "Starts an agent on a task in a new thread in your project. Returns its id; with `wait`, also its answer.",
      inputSchema: StartThreadInput,
    },
    (input) => runToolEffect(orchestration.startThread(caller, input)),
  );

  server.registerTool(
    "start_threads",
    {
      description:
        "Starts several threads at once, one per task, each like start_thread without waiting. Returns each one's id, or why it couldn't start. Their answers come to you as messages.",
      inputSchema: {
        threads: z
          .array(z.object(StartThreadInput).omit({ wait: true, timeoutSeconds: true }))
          .min(1)
          .max(10),
      },
    },
    ({ threads }) => runToolEffect(orchestration.startThreads(caller, threads)),
  );

  server.registerTool(
    "rename_thread",
    {
      description: "Renames a thread in the user's sidebar: yours, or another in your project.",
      inputSchema: { threadId: z.string(), title: z.string() },
    },
    ({ threadId, title }) => runToolEffect(orchestration.renameThread(caller, threadId, title)),
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Sends a message to a thread: it starts a turn, or joins the one running. Its answer comes to you as a message once the turn ends.",
      inputSchema: SendMessageInput,
    },
    (input) => runToolEffect(orchestration.sendMessage(caller, input)),
  );

  server.registerTool(
    "wait_for_thread",
    {
      description:
        "Waits until a thread's agent finishes its turn, then returns its status and last answer. Returns early with `waitingOn` when it stops for an approval or questions. A timeout returns the status so far and leaves it working.",
      inputSchema: WaitInput,
      annotations: readOnly,
    },
    ({ threadId, timeoutSeconds }) =>
      runToolEffect(
        orchestration.waitForThread(caller, threadId, (timeoutSeconds ?? WAIT_MS / 1000) * 1000),
      ),
  );

  server.registerTool(
    "answer_questions",
    {
      description:
        "Answers the questions a thread's agent stopped to ask, as given by wait_for_thread's `waitingOn` or the message forwarding them. Its turn then carries on.",
      inputSchema: AnswerQuestionsInput,
    },
    (input) => runToolEffect(orchestration.answerQuestions(caller, input)),
  );

  server.registerTool(
    "watch_pull_request",
    {
      description:
        "Watches a GitHub pull request for your thread: new reviews and comments from others, and checks starting to fail, come to you as messages, so you can address them. Merging or closing it ends the watch and shelves your thread. Use it after opening a pull request you're responsible for.",
      inputSchema: WatchPullRequestInput,
    },
    (input) => runToolEffect(orchestration.watchPullRequest(caller, input)),
  );

  server.registerTool(
    "stop_thread",
    {
      description: "Stops a thread's running turn, and the threads its agent started.",
      inputSchema: { threadId: z.string() },
    },
    ({ threadId }) => runToolEffect(orchestration.stopThread(caller, threadId)),
  );

  return server;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createBrowserServer(
  requestBrowserAction: (action: BrowserAction) => Promise<BrowserResult>,
) {
  async function runBrowserAction(action: BrowserAction) {
    try {
      const result = await requestBrowserAction(action);

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
        content: [{ type: "text" as const, text: getErrorMessage(error) }],
        isError: true,
      };
    }
  }

  const server = new McpServer(
    { name: "browser", version: "1.0.0" },
    {
      instructions:
        "A real browser the user watches in MassCode's Browser panel next to this thread; it shares their logins. Use it to check web apps you build (such as a local dev server) or to read pages. Call snapshot to see the page (text, interactive elements with refs like e3, and a screenshot), then click or type by ref. Refs go stale after navigation or re-renders, so take a new snapshot when an action says nothing matches.",
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
    ({ url }) => runBrowserAction(BrowserAction.cases.navigate.make({ url })),
  );

  server.registerTool(
    "snapshot",
    {
      description:
        "See the current page: URL, title, visible text, interactive elements with refs, and a screenshot.",
      annotations: { readOnlyHint: true },
      _meta: alwaysLoad,
    },
    () => runBrowserAction(BrowserAction.cases.snapshot.make({})),
  );

  server.registerTool(
    "click",
    {
      description:
        "Click an element by ref from the latest snapshot (such as e3) or by CSS selector.",
      inputSchema: { target: z.string() },
      _meta: alwaysLoad,
    },
    ({ target }) => runBrowserAction(BrowserAction.cases.click.make({ target })),
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
      runBrowserAction(BrowserAction.cases.type.make({ target, text, submit: submit ?? false })),
  );

  server.registerTool(
    "press",
    {
      description: "Press a key in the page, such as Enter, Tab, Escape, Backspace or ArrowDown.",
      inputSchema: { key: z.string() },
      _meta: alwaysLoad,
    },
    ({ key }) => runBrowserAction(BrowserAction.cases.press.make({ key })),
  );

  server.registerTool(
    "evaluate",
    {
      description: "Run a JavaScript expression in the page and return its JSON value.",
      inputSchema: { expression: z.string() },
      _meta: alwaysLoad,
    },
    ({ expression }) => runBrowserAction(BrowserAction.cases.evaluate.make({ expression })),
  );

  server.registerTool(
    "console",
    {
      description: "Read the page's recent console messages and errors.",
      annotations: { readOnlyHint: true },
      _meta: alwaysLoad,
    },
    () => runBrowserAction(BrowserAction.cases.console.make({})),
  );

  return server;
}

function createDeviceServer(threadId: string, devices: Devices) {
  async function runDeviceTool(
    content: () => Promise<CallToolResult["content"]>,
  ): Promise<CallToolResult> {
    try {
      return { content: await content() };
    } catch (error) {
      return {
        content: [{ type: "text", text: getErrorMessage(error) }],
        isError: true,
      };
    }
  }

  const server = new McpServer(
    { name: "device", version: "1.0.0" },
    {
      instructions:
        "An iOS simulator or Android emulator the user watches in MassCode's Simulator panel next to this thread. Call device_open to show one and learn how to drive it, before simctl, adb or computer use.",
    },
  );

  server.registerTool(
    "device_open",
    {
      description:
        "Boots an iOS simulator or Android emulator if needed, shows it in the Simulator panel, and returns how to drive it with the agent-device CLI. Opens the thread's device, or a booted phone of the platform, unless deviceId names another. The first call can take minutes while the tools install.",
      inputSchema: {
        deviceId: z
          .string()
          .optional()
          .describe(
            "A simulator UDID (`xcrun simctl list devices`) or an emulator's AVD name (`emulator -list-avds`).",
          ),
        platform: z
          .enum(DevicePlatform.literals)
          .optional()
          .describe("Which kind of phone to open when deviceId is left out."),
      },
    },
    ({ deviceId, platform }) =>
      runDeviceTool(async () => {
        const { device, cli } = await devices.open(threadId, deviceId ?? null, platform ?? null);
        const target = `${device.platform === "ios" ? `--platform ios --udid ${device.id}` : `--platform android --serial ${device.streamId}`} --session ${nameAgentSession(threadId)}`;
        const app = device.platform === "ios" ? "<bundle-id>" : "<package>";

        return [
          {
            type: "text",
            text: [
              `The user is watching ${device.name} (${device.version}, ${device.platform === "ios" ? "UDID" : "serial"} ${device.streamId}) in the Simulator panel and can tap along.`,
              `Drive it with ${cli}; use that exact path and always pass ${target}. Typical loop:`,
              `  ${cli} open ${app} --foreground ${target}   # launch an app; prints a snapshot with @refs`,
              `  ${cli} snapshot -i ${target}   # accessibility tree with @eN refs`,
              `  ${cli} press @e3 --settle ${target}`,
              `  ${cli} fill @e5 "text" --settle ${target}`,
              `  ${cli} install ${app} ${device.platform === "ios" ? "<path-to-.app>" : "<path-to-.apk>"} ${target}`,
              device.platform === "ios"
                ? `Build for it with xcodebuild -destination 'id=${device.id}'.`
                : `Install builds with adb -s ${device.streamId} install, or the install command above.`,
              `Prefer refs over coordinates. Call device_screenshot to see the screen. Run \`${cli} help workflow\` for more.`,
              "The first command on a device sets up its automation runner and can take a couple of minutes; later ones are fast.",
            ].join("\n"),
          },
        ];
      }),
  );

  server.registerTool(
    "device_screenshot",
    {
      description: "See the screen of the device open in this thread's Simulator panel.",
      annotations: { readOnlyHint: true },
    },
    () =>
      runDeviceTool(async () => [
        { type: "image", data: await devices.takeScreenshot(threadId), mimeType: "image/png" },
      ]),
  );

  return server;
}

export function createMcp(
  requestBrowserAction: (threadId: string, action: BrowserAction) => Promise<BrowserResult>,
  orchestration: Orchestration,
  devices: Devices,
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
      const tokenHash = hashToken(token);
      threadByTokenHash.set(tokenHash, threadId);
      tokenHashByThread.set(threadId, tokenHash);

      return { url: `http://127.0.0.1:${PORT}/mcp`, token };
    },
    revoke,
    async handleRequest(request: Request) {
      const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/)?.[1];
      const threadId = token ? threadByTokenHash.get(hashToken(token)) : undefined;

      if (threadId === undefined)
        return new Response("A valid bearer token is required", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });

      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await Match.value(new URL(request.url).pathname)
        .pipe(
          Match.when("/mcp/masscode", () => createOrchestrationServer(threadId, orchestration)),
          Match.when("/mcp/device", () => createDeviceServer(threadId, devices)),
          Match.orElse(() =>
            createBrowserServer((action) => requestBrowserAction(threadId, action)),
          ),
        )
        .connect(transport);

      return transport.handleRequest(request);
    },
  };
}
