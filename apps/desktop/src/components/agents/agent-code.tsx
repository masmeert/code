"use client";

import {
  type CSSProperties,
  Fragment,
  useEffect,
  useState,
} from "react";
import {
  type BundledLanguage,
  bundledLanguages,
  createHighlighter,
  type Highlighter,
  type SpecialLanguage,
} from "shiki";
import { cn } from "@/lib/utils";

/** Any Shiki language id or alias; unknown ones render as plain text. */
export type AgentCodeLanguage =
  | "bash"
  | "diff"
  | "json"
  | "text"
  | "tsx"
  | "typescript"
  | (string & {});

export interface AgentCodeToken {
  content: string;
  offset: number;
  light?: string;
  dark?: string;
}

export type AgentCodeTokenLines = AgentCodeToken[][];

export interface AgentCodeProps {
  code: string;
  language?: AgentCodeLanguage;
  className?: string;
}

export interface AgentCodeLineProps {
  code: string;
  tokens?: AgentCodeToken[];
  className?: string;
}

const LIGHT_THEME = "github-light-high-contrast";
const DARK_THEME = "github-dark-high-contrast";
let agentCodeHighlighter: Promise<Highlighter> | null = null;
const tokenCache = new Map<string, AgentCodeTokenLines>();

function getAgentCodeHighlighter() {
  if (!agentCodeHighlighter) {
    agentCodeHighlighter = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: ["bash", "diff", "json", "tsx", "typescript"],
    });
  }
  return agentCodeHighlighter;
}

/** Loads grammars beyond the preloaded set on first use. */
async function ensureLanguage(
  highlighter: Highlighter,
  language: string,
): Promise<BundledLanguage | SpecialLanguage> {
  if (language === "text" || !(language in bundledLanguages)) return "text";
  const lang = language as BundledLanguage;
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    await highlighter.loadLanguage(lang);
  }
  return lang;
}

function tokenCacheKey(code: string, language: AgentCodeLanguage) {
  return `${language}\u0000${code}`;
}

export function useAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
) {
  const key = tokenCacheKey(code, language);
  const cached = tokenCache.get(key);
  const [result, setResult] = useState<{
    key: string;
    code: string;
    language: AgentCodeLanguage;
    lines: AgentCodeTokenLines;
  } | null>(cached ? { key, code, language, lines: cached } : null);

  useEffect(() => {
    const current = tokenCache.get(key);
    if (current) {
      setResult({ key, code, language, lines: current });
      return;
    }

    let cancelled = false;
    getAgentCodeHighlighter().then(async (highlighter) => {
      const lang = await ensureLanguage(highlighter, language).catch(
        () => "text" as const,
      );
      if (cancelled) return;
      const lines = highlighter
        .codeToTokensWithThemes(code, {
          lang,
          themes: {
            light: LIGHT_THEME,
            dark: DARK_THEME,
          },
        })
        .map((line) =>
          line.map((token) => ({
            content: token.content,
            offset: token.offset,
            light: token.variants.light?.color,
            dark: token.variants.dark?.color,
          })),
      );
      tokenCache.set(key, lines);
      setResult({ key, code, language, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [code, key, language]);

  if (result?.key === key) return result.lines;
  if (result?.language === language && code.startsWith(result.code)) {
    return result.lines;
  }
  return null;
}

export function AgentCodeLine({
  code,
  tokens,
  className,
}: AgentCodeLineProps) {
  return (
    <span className={className}>
      {tokens
        ? tokens.map((token) => (
            <span
              key={`${token.offset}-${token.content}`}
              style={
                {
                  "--agent-code-light": token.light ?? "currentColor",
                  "--agent-code-dark": token.dark ?? token.light ?? "currentColor",
                } as CSSProperties
              }
              className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
            >
              {token.content}
            </span>
          ))
        : code}
    </span>
  );
}

export function AgentCode({
  code,
  language = "bash",
  className,
}: AgentCodeProps) {
  const tokens = useAgentCodeTokens(code, language);
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });

  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground/85",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <Fragment key={line.offset}>
            <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
            {index < lines.length - 1 ? "\n" : null}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}
