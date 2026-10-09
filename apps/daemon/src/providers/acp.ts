/**
 * The Agent Client Protocol (agentclientprotocol.com) as MassCode speaks it to an agent's stdio,
 * decoded down to the fields MassCode reads.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { connectJsonRpc, type JsonRpc, type RpcId } from "./jsonRpc.ts";
import type { HarnessLaunch } from "./launch.ts";

export type { RpcId };

/** A setting the session takes, like its mode, model or effort. */
export const ConfigOption = Schema.Struct({
  id: Schema.String,
  category: Schema.optional(Schema.NullOr(Schema.String)),
  currentValue: Schema.optional(Schema.Unknown),
  options: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String }))),
});
export type ConfigOption = typeof ConfigOption.Type;

/** What `session/new`, `session/load` and `session/set_config_option` answer with. */
export const SessionSetup = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  configOptions: Schema.optional(Schema.Array(ConfigOption)),
});

const TextBlock = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) });

export const ToolContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("content"), content: TextBlock }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    path: Schema.String,
    newText: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("terminal") }),
]);
export type ToolContent = typeof ToolContent.Type;

const ToolFields = {
  toolCallId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  rawInput: Schema.optional(Schema.Json),
  rawOutput: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.NullOr(Schema.Array(ToolContent))),
  locations: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ path: Schema.String })))),
};

/** The `session/update` kinds MassCode acts on; others are dropped. */
export const SessionUpdate = Schema.Union([
  Schema.Struct({ sessionUpdate: Schema.Literal("agent_message_chunk"), content: TextBlock }),
  Schema.Struct({ sessionUpdate: Schema.Literal("agent_thought_chunk"), content: TextBlock }),
  Schema.Struct({ sessionUpdate: Schema.Literal("tool_call"), ...ToolFields }),
  Schema.Struct({ sessionUpdate: Schema.Literal("tool_call_update"), ...ToolFields }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        input: Schema.optional(Schema.NullOr(Schema.Struct({ hint: Schema.String }))),
      }),
    ),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("config_option_update"),
    configOptions: Schema.Array(ConfigOption),
  }),
]).pipe(Schema.toTaggedUnion("sessionUpdate"));
export type SessionUpdate = typeof SessionUpdate.Type;

export const PermissionRequest = Schema.Struct({
  toolCall: Schema.Struct(ToolFields),
  options: Schema.Array(Schema.Struct({ optionId: Schema.String, kind: Schema.String })),
});
export type PermissionRequest = typeof PermissionRequest.Type;

export const PromptResponse = Schema.Struct({ stopReason: Schema.String });

const decodeUpdate = Schema.decodeUnknownOption(Schema.Struct({ update: SessionUpdate }));

interface AcpHandlers {
  readonly onUpdate?: (update: SessionUpdate) => void;
  /** Requests the agent makes of us, permission and extensions; unhandled ones get method-not-found. */
  readonly onRequest?: (id: RpcId, method: string, params: Schema.Json | undefined) => boolean;
  readonly onExit?: (code: number | null, stderrTail: string) => void;
}

/**
 * Spawns an ACP agent and completes `initialize`. It reads and writes files and runs commands
 * itself: MassCode offers neither its filesystem nor terminals.
 */
export async function connectAcp(
  name: string,
  launch: HarnessLaunch,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  handlers: AcpHandlers = {},
): Promise<JsonRpc> {
  const rpc = connectJsonRpc(
    name,
    launch,
    args,
    cwd,
    {
      onNotification: (method, params) => {
        if (method !== "session/update") return;

        const update = decodeUpdate(params);
        if (Option.isSome(update)) handlers.onUpdate?.(update.value.update);
      },
      onRequest: handlers.onRequest,
      onExit: handlers.onExit,
    },
    { isVersioned: true },
  );

  await rpc.request(
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Cursor: models come with their effort and fast settings as config options of their own.
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: { name: "masscode", title: "MassCode", version: "0.0.1" },
    },
    Schema.Unknown,
  );

  return rpc;
}

/** The text an update or tool result carries, for the transcript. */
export function getContentText(content: ReadonlyArray<ToolContent> | null | undefined) {
  return (content ?? [])
    .flatMap((part) => {
      switch (part.type) {
        case "content":
          return part.content.text ?? [];
        case "diff":
          return `${part.path}\n${part.newText}`;
        case "terminal":
          return [];
      }
    })
    .join("\n");
}
