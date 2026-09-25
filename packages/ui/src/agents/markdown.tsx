import { createContext, isValidElement, memo, type ReactElement, use } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@apcode/ui/agents/code-block";
import { cn } from "@apcode/ui/lib/utils";

export interface MarkdownProps {
  children: string;
  /** While true, a code fence still open at the end of the text shows as writing. */
  streaming?: boolean;
  className?: string;
}

type CodeElement = ReactElement<{ className?: string; children?: unknown }>;

const languageOf = (className?: string) =>
  /language-([\w+#.-]+)/.exec(className ?? "")?.[1]?.toLowerCase() ?? "text";

/** The source a markdown root renders, for renderers that need more than their node. */
const SourceContext = createContext<{ readonly text: string; readonly streaming: boolean }>({
  text: "",
  streaming: false,
});

/**
 * Module-level, so element types stay the same between renders: a new object each
 * render would remount every paragraph and code block on every streamed token.
 */
const components: Components = {
  pre: function Pre({ node, children }) {
    const { text, streaming } = use(SourceContext);
    const code = isValidElement(children) ? (children as CodeElement) : null;
    const source = String(code?.props.children ?? "").replace(/\n$/, "");
    const open = streaming && node?.position?.end.offset === text.length;
    return (
      <CodeBlock
        code={source}
        language={languageOf(code?.props.className)}
        status={open ? "streaming" : "complete"}
        showStatus={false}
        maxHeight={360}
        className="my-3"
      />
    );
  },
  code: ({ className, children }) => (
    <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]", className)}>
      {children}
    </code>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium underline underline-offset-4"
    >
      {children}
    </a>
  ),
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-lg font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="[&+*]:mt-3">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-muted/60 px-3 py-1.5 font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-3 py-1.5 align-top">{children}</td>
  ),
};

const plugins = [remarkGfm];

const FENCE = /^(`{3,}|~{3,})/;
/** Link reference definitions apply across the whole text, so text using them can't be split. */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * Where the text can be cut into two independently parsed parts: after the last
 * closed top-level code fence that's followed by a blank line (t3code's boundary for
 * incremental parsing). Everything before it can no longer change as text streams in.
 */
const stableEnd = (text: string) => {
  if (!text.includes("```") && !text.includes("~~~")) return 0;
  if (DEFINITION.test(text)) return 0;
  let end = 0;
  let open: string | null = null;
  let closedAt = -1;
  let offset = 0;
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1;
    if (closedAt >= 0) {
      if (line.trim() === "") end = next;
      closedAt = -1;
    }
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      if (open === null) open = fence;
      else if (
        fence[0] === open[0] &&
        fence.length >= open.length &&
        line.slice(fence.length).trim() === ""
      ) {
        open = null;
        closedAt = offset;
      }
    }
    offset = next;
  }
  return Math.min(end, text.length);
};

const MarkdownPart = memo(function MarkdownPart({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <SourceContext value={{ text, streaming }}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </SourceContext>
  );
});

/**
 * Agent markdown, with fenced code rendered by CodeBlock. Text before the
 * last finished code block is its own part, so streaming only re-parses the rest.
 */
export const Markdown = memo(function Markdown({
  children,
  streaming = false,
  className,
}: MarkdownProps) {
  const cut = stableEnd(children);
  return (
    <div className={cn("min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      {cut > 0 ? <MarkdownPart text={children.slice(0, cut)} streaming={false} /> : null}
      {cut < children.length ? (
        <MarkdownPart text={children.slice(cut)} streaming={streaming} />
      ) : null}
    </div>
  );
});
