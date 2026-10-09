import {
  Message,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageGroup,
  MessageScroller,
} from "@masscode/ui/agents/message";
import { ReasoningText } from "@masscode/ui/agents/loading-states/reasoning-text";
import { Button } from "@masscode/ui/motion/button/base";
import { Drawer } from "@masscode/ui/motion/drawer";
import { Textarea } from "@masscode/ui/components/textarea";
import { type ProviderKind } from "@masscode/contracts";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatHarnessLabel } from "../lib/models.ts";
import { askSideChat, closeSideChat, useStore } from "../lib/store.ts";
import { NO_ITEMS, toBlocks, hasNewestItem, isShowingWork } from "../lib/transcriptBlocks.ts";
import { AgentBlock } from "./Transcript.tsx";

/** Read-only side questions about one reply (BTW), over the thread; closing it ends them for good. */
export function SideChatDrawer({
  threadId,
  provider,
}: {
  threadId: string;
  provider: ProviderKind;
}) {
  const sideChat = useStore((state) =>
    state.sideChat?.threadId === threadId ? state.sideChat : null,
  );
  const label = useStore((state) => formatHarnessLabel(state.settings, provider));
  const [question, setQuestion] = useState("");

  useEffect(() => () => closeSideChat(threadId), [threadId]);

  const items = sideChat?.items ?? NO_ITEMS;
  const isRunning = sideChat?.running ?? false;
  const lastItem = items.at(-1);
  const blocks = useMemo(() => toBlocks(items), [items]);

  function askQuestion() {
    const text = question.trim();
    if (!text || isRunning) return;
    askSideChat(text);
    setQuestion("");
  }

  return (
    <Drawer
      open={sideChat !== null}
      onOpenChange={(isOpen) => isOpen || closeSideChat(threadId)}
      ariaLabel="Side question"
      className="w-[32rem]"
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">By the way</h2>
          <p className="text-xs text-muted-foreground">
            Ask {label} about this reply. It can read but not change anything, and nothing here goes
            into the thread.
          </p>
        </div>
        <button
          type="button"
          title="Close and discard (esc)"
          aria-label="Close and discard"
          onClick={() => closeSideChat(threadId)}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
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
            <div className="flex h-7 items-center text-sm">
              <ReasoningText variant="scramble" className="min-w-0 font-mono font-normal" />
            </div>
          ) : null}
        </MessageGroup>
      </MessageScroller>
      <form
        className="border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          askQuestion();
        }}
      >
        <Textarea
          autoFocus
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            askQuestion();
          }}
          placeholder={isRunning ? `${label} is answering…` : "Ask a side question…"}
          aria-label="Side question"
          className="min-h-16 text-[13px]"
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" disabled={!question.trim() || isRunning}>
            Ask
            <kbd aria-hidden className="font-sans text-[10px] opacity-70">
              ↵
            </kbd>
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
