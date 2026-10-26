import { Button } from "@masmeert/ui/button";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { cn } from "@masscode/ui/lib/utils";
import type { ReactNode } from "react";

/** What a side panel shows instead of its content: loading, empty, or an error and the way out. */
export function PanelMessage({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        typeClass("body"),
        "flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** The one button style for a panel's next step: Try again, Set up, Close. */
export function PanelAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="compact"
      disabled={disabled}
      onClick={onClick}
      className="h-7 px-2.5"
    >
      {children}
    </Button>
  );
}

/** The raw error behind a plain-language message, folded away until asked for. */
export function ErrorDetails({ children }: { children: string }) {
  return (
    <details className={cn(typeClass("caption"), "max-w-full text-muted-foreground")}>
      <summary className="cursor-default rounded-md outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Details
      </summary>
      <pre className="mt-1 max-h-40 selectable overflow-auto text-left font-mono break-words whitespace-pre-wrap">
        {children}
      </pre>
    </details>
  );
}
