/** Side chats (BTW): read-only side conversations about one reply, never stored. */
import { type ClientCommand, RuntimeEvent } from "@masscode/contracts";
import * as Effect from "effect/Effect";
import { CommandError } from "../errors.ts";
import { buildHandoff } from "../handoff.ts";
import { ADAPTERS, getHarnessName } from "../harnesses.ts";
import type { ProviderSession } from "../providers/ProviderAdapter.ts";
import type { SettingsStore } from "../storage/SettingsStore.ts";
import type { ThreadStore } from "../storage/ThreadStore.ts";
import type { Agents } from "./agents.ts";
import { getForkPoint, hasSwitchedHarness, isBusy, type ThreadEntry } from "./entry.ts";
import type { ThreadRegistry } from "./registry.ts";

interface SideChat {
  /** Null while its agent starts. */
  session: ProviderSession | null;
}

export function createSideChats({
  runFork,
  store,
  settingsStore,
  getEntry,
  publishSideChat,
  reportErrorsIn,
  ensureHarnessReady,
}: Pick<ThreadRegistry, "getEntry" | "publishSideChat" | "reportErrorsIn"> &
  Pick<Agents, "ensureHarnessReady"> & {
    readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => void;
    readonly store: typeof ThreadStore.Service;
    readonly settingsStore: typeof SettingsStore.Service;
  }) {
  /** Side chats (BTW) by id; closing one forgets it. */
  const sideChats = new Map<string, SideChat>();

  /**
   * Starts a side chat's agent in plan mode, with no MassCode tools, on a copy of the thread's
   * conversation through the turn of `messageId`. Resolves to what to hand it with the first
   * question when there's no copy, and to null when the chat was closed while it started.
   */
  const startSideChat = Effect.fn("startSideChat")(function* (
    source: ThreadEntry,
    messageId: string,
    sideChatId: string,
  ) {
    const { id: threadId, provider } = source.info;
    yield* ensureHarnessReady(provider);

    const cut = store.findTurnsAfter(threadId, messageId);
    if (!cut) return yield* new CommandError({ message: "That reply is gone" });

    const settings = yield* settingsStore.get;
    const harness = settings.providers[provider];
    const sourceToken = source.resumeTokens[provider];
    // A running turn is still writing the harness's log, and some harnesses can't copy theirs:
    // the agent then starts afresh, handed the transcript instead.
    const resumeToken =
      sourceToken && !hasSwitchedHarness(source) && !isBusy(source)
        ? yield* ADAPTERS[provider]
            .fork({
              cwd: source.home.path,
              harness,
              resumeToken: sourceToken,
              ...getForkPoint(cut),
            })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
    const handoff = resumeToken
      ? null
      : buildHandoff({
          events: store
            .readAfter(threadId, 0)
            .filter((stored) => cut.seq === null || stored.id < cut.seq)
            .map((stored) => stored.event),
          isFresh: true,
          getHarnessName: (kind) => getHarnessName(settings, kind),
        });

    const chat: SideChat = { session: null };
    sideChats.set(sideChatId, chat);
    const session = yield* ADAPTERS[provider].start({
      threadId: sideChatId,
      cwd: source.home.path,
      harness,
      model: source.info.model ?? harness.defaultModel ?? undefined,
      resumeToken: resumeToken ?? undefined,
      effort: null,
      permission: "plan",
      onResumeToken: () => {},
      onCwd: () => {},
      emit: (event) => {
        if (sideChats.get(sideChatId) !== chat) return;

        // Read-only: whatever the agent asks to do beyond reading is refused.
        if (RuntimeEvent.guards["approval.requested"](event)) {
          if (chat.session)
            runFork(Effect.ignore(chat.session.respondApproval(event.requestId, "deny")));
          return;
        }

        if (
          RuntimeEvent.guards["thread.status"](event) &&
          (event.status === "closed" || event.status === "error")
        )
          sideChats.delete(sideChatId);
        publishSideChat(event);
      },
      mcpServer: null,
    });
    if (sideChats.get(sideChatId) !== chat) {
      yield* session.close;
      return null;
    }

    chat.session = session;
    return { session, handoff: handoff?.text ?? null };
  });

  const askSideChat = Effect.fn("askSideChat")(
    function* ({
      threadId,
      messageId,
      sideChatId,
      text,
    }: Extract<ClientCommand, { _tag: "sideChat.ask" }>) {
      const source = yield* getEntry(threadId);
      const session = sideChats.get(sideChatId)?.session;
      if (sideChats.has(sideChatId) && !session)
        return yield* new CommandError({
          message: "The side chat is still starting. Ask again in a moment.",
        });

      const questionId = crypto.randomUUID();
      publishSideChat(
        RuntimeEvent.cases["user.message"].make({
          threadId: sideChatId,
          messageId: questionId,
          text,
          provider: source.info.provider,
        }),
      );
      publishSideChat(
        RuntimeEvent.cases["thread.status"].make({ threadId: sideChatId, status: "running" }),
      );

      const started = session
        ? { session, handoff: null }
        : yield* startSideChat(source, messageId, sideChatId);
      if (!started)
        return publishSideChat(
          RuntimeEvent.cases["thread.status"].make({ threadId: sideChatId, status: "idle" }),
        );

      yield* started.session.send({
        // SAFETY: from crypto.randomUUID() above.
        messageId: questionId as `${string}-${string}-${string}-${string}-${string}`,
        text: session
          ? text
          : `This is a by-the-way question about our conversation, asked on the side: answer it without changing any files or making a plan.\n\n${text}`,
        attachments: [],
        effort: null,
        permission: "plan",
        skills: [],
        handoff: started.handoff,
      });
    },
    (effect, { sideChatId }) =>
      effect.pipe(
        reportErrorsIn(sideChatId, publishSideChat),
        Effect.tapError(() =>
          Effect.sync(() =>
            publishSideChat(
              RuntimeEvent.cases["thread.status"].make({ threadId: sideChatId, status: "idle" }),
            ),
          ),
        ),
      ),
  );

  const closeSideChat = Effect.fn("closeSideChat")(function* (sideChatId: string) {
    const chat = sideChats.get(sideChatId);
    sideChats.delete(sideChatId);
    if (chat?.session) yield* chat.session.close;
  });

  return {
    ask: askSideChat,
    close: closeSideChat,
    closeAll: Effect.suspend(() =>
      Effect.forEach([...sideChats.keys()], closeSideChat, { discard: true }),
    ),
  };
}
