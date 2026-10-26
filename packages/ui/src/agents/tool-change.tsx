import { AgentCode } from "@masscode/ui/agents/agent-code";
import { cn } from "@masscode/ui/lib/utils";
import { type ToolCall, toDiffLines } from "@masscode/client";
import { typeClass } from "@masmeert/ui/lib/type-scale";

type ToolChange = NonNullable<ToolCall["change"]>;

function EditDiff({ edits }: { edits: Extract<ToolChange, { _tag: "edit" }>["edits"] }) {
  return (
    <div className={cn(typeClass("caption"), "min-w-max font-mono leading-5")}>
      {edits.map((edit, editIndex) => (
        // Edits keep their order and never move, so their position is who they are.
        <div key={editIndex} className={cn(editIndex > 0 && "mt-2 border-t border-border pt-2")}>
          {toDiffLines(edit.before, edit.after).map((line, lineIndex) => (
            <div
              key={lineIndex}
              className={cn(
                "grid grid-cols-[1.25rem_minmax(0,1fr)] pr-3 whitespace-pre",
                line.type === "added" && "bg-success/10",
                line.type === "removed" && "bg-destructive/10",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "text-center text-muted-foreground select-none",
                  line.type === "added" && "text-success",
                  line.type === "removed" && "text-destructive",
                )}
              >
                {line.type === "added" ? "+" : line.type === "removed" ? "−" : ""}
              </span>
              <span className="text-foreground">
                <span className="sr-only">
                  {line.type === "added" ? "Added: " : line.type === "removed" ? "Removed: " : ""}
                </span>
                {line.text || " "}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** What a tool call changes: an edit's diff, a written file's content, or a command. */
export function ToolChangePreview({
  change,
  className,
}: {
  change: ToolChange;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "scrollbar-hide max-h-72 selectable overflow-auto rounded-lg bg-muted/80 py-2",
        className,
      )}
    >
      {change._tag === "edit" ? (
        <EditDiff edits={change.edits} />
      ) : (
        <AgentCode
          code={change._tag === "write" ? change.content : change.command}
          language={
            change._tag === "write"
              ? (/\.([\w]+)$/.exec(change.path)?.[1]?.toLowerCase() ?? "text")
              : "bash"
          }
          className="px-3"
        />
      )}
    </div>
  );
}
