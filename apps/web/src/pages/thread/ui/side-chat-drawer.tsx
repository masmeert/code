import {
  Message,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageGroup,
  MessageScroller,
} from "@masscode/ui/agents/message";
import { ReasoningText } from "@masscode/ui/agents/loading-states/reasoning-text";
import { PromptInput } from "@masscode/ui/agents/prompt-input";
import { Sheet } from "@masmeert/ui/sheet";
import { type ProviderKind } from "@masscode/contracts";
import { IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { formatHarnessLabel } from "@/entities/provider";
import { useSetting } from "@/entities/settings";
import { askSideChat, closeSideChat, useSideChat } from "@/features/side-chat";
import { NO_ITEMS, toBlocks, hasNewestItem, isShowingWork } from "@masscode/client";
import { AgentBlock } from "./transcript.tsx";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { cn } from "@masscode/ui/lib/utils";

/** Read-only side questions about one reply (BTW), over the thread; closing it ends them for good. */
export function SideChatDrawer({
  threadId,
  provider,
}: {
  threadId: string;
  provider: ProviderKind;
}) {
  const sideChat = useSideChat(threadId);

  const label = useSetting((settings) => formatHarnessLabel(settings, provider));
  const [question, setQuestion] = useState("");

  useEffect(() => () => closeSideChat(threadId), [threadId]);

  const items = sideChat?.items ?? NO_ITEMS;
  const isRunning = sideChat?.running ?? false;
  const lastItem = items.at(-1);
  const blocks = useMemo(() => toBlocks(items), [items]);

  return (
    <Sheet
      open={sideChat !== null}
      onOpenChange={(isOpen) => isOpen || closeSideChat(threadId)}
      ariaLabel="Side question"
      className="w-[32rem] border-l border-border bg-background"
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className={cn(typeClass("body"), "font-medium")}>By the way</h2>
          <p className={cn(typeClass("caption"), "text-muted-foreground")}>
            Ask {label} about this reply. It can read but not change anything, and nothing here goes
            into the thread.
          </p>
        </div>
        <button
          type="button"
          title="Close and discard (esc)"
          aria-label="Close and discard"
          onClick={() => closeSideChat(threadId)}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconX className="size-4" />
        </button>
      </div>
      <MessageScroller
        busy={isRunning}
        className="min-h-0 flex-1"
        viewportClassName="px-4 py-4"
        contentClassName="min-h-full w-full"
      >
        <MessageGroup spacing="default">
          {sideChat
            ? blocks.map((block) =>
                block.kind === "user" ? (
                  <Message key={block.id} from="user">
                    <MessageContent>
                      <MessageBubble variant="soft">
                        <MessageBubbleContent className="selectable whitespace-pre-wrap">
                          {block.text}
                        </MessageBubbleContent>
                      </MessageBubble>
                    </MessageContent>
                  </Message>
                ) : (
                  <AgentBlock
                    key={block.id}
                    block={block}
                    threadId={sideChat.id}
                    live={isRunning}
                    streaming={isRunning && hasNewestItem(block, lastItem)}
                    showActions={false}
                  />
                ),
              )
            : null}
          {isRunning && !isShowingWork(items) ? (
            <div className={cn(typeClass("body"), "flex h-7 items-center")}>
              <ReasoningText variant="swap" className="min-w-0 font-normal" />
            </div>
          ) : null}
        </MessageGroup>
      </MessageScroller>
      <PromptInput
        autoFocus
        value={question}
        onValueChange={setQuestion}
        onSubmit={(text) => {
          askSideChat(text);
          setQuestion("");
        }}
        submitDisabled={isRunning}
        maxRows={6}
        placeholder={isRunning ? `${label} is answering…` : "Ask a side question…"}
        aria-label="Side question"
        className="p-3"
      />
    </Sheet>
  );
}
