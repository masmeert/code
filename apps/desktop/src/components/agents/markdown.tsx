import { isValidElement, memo, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/agents/code-block";
import { cn } from "@/lib/utils";

export interface MarkdownProps {
  children: string;
  /** While true, a code fence still open at the end of the text shows as writing. */
  streaming?: boolean;
  className?: string;
}

type CodeElement = ReactElement<{ className?: string; children?: unknown }>;

const languageOf = (className?: string) => /language-([\w+#.-]+)/.exec(className ?? "")?.[1]?.toLowerCase() ?? "text";

const components = (text: string, streaming: boolean): Components => ({
  pre: ({ node, children }) => {
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
    <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]", className)}>{children}</code>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
      {children}
    </a>
  ),
  h1: ({ children }) => <h1 className="mb-2 mt-5 text-lg font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-5 text-base font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-4 font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="[&+*]:mt-3">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border bg-muted/60 px-3 py-1.5 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/60 px-3 py-1.5 align-top">{children}</td>,
});

const plugins = [remarkGfm];

/** Agent markdown, with fenced code rendered by the beUI code viewer. */
export const Markdown = memo(function Markdown({ children, streaming = false, className }: MarkdownProps) {
  return (
    <div className={cn("min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components(children, streaming)}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
