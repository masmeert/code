import {
  type CSSProperties,
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BundledLanguage,
  bundledLanguages,
  createHighlighter,
  type GrammarState,
  type Highlighter,
} from "shiki";
import { cn } from "@apcode/ui/lib/utils";

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
const THEMES = { light: LIGHT_THEME, dark: DARK_THEME } as const;
/** Past this, a block renders plain: tokenizing it would stall the main thread. */
const MAX_HIGHLIGHT_CHARS = 200_000;

let highlighterPromise: Promise<Highlighter> | null = null;
/** Set once the highlighter has loaded, so later blocks can tokenize synchronously. */
let highlighter: Highlighter | null = null;

function getAgentCodeHighlighter() {
  highlighterPromise ??= createHighlighter({
    themes: [LIGHT_THEME, DARK_THEME],
    langs: ["bash", "diff", "json", "tsx", "typescript"],
  }).then((h) => (highlighter = h));
  return highlighterPromise;
}

/** The grammar to use for `language` if it's ready now: null while loading, "text" if there is none. */
function readyLanguage(language: string): BundledLanguage | "text" | null {
  if (language === "text" || !(language in bundledLanguages)) return "text";
  if (!highlighter) return null;
  return highlighter.getLoadedLanguages().includes(language) ? (language as BundledLanguage) : null;
}

/** Loads the highlighter and the grammar for `language`. */
async function prepareLanguage(language: string) {
  const h = await getAgentCodeHighlighter();
  if (readyLanguage(language) !== null) return;
  await h.loadLanguage(language as BundledLanguage).catch(() => undefined);
}

/**
 * Finished blocks' tokens, least recently used first. Bounded by entries and by
 * source size, like t3code's highlight cache (500 entries / 50MB there).
 */
const MAX_CACHE_ENTRIES = 500;
const MAX_CACHE_CHARS = 8_000_000;
const tokenCache = new Map<string, { lines: AgentCodeTokenLines; size: number }>();
let tokenCacheChars = 0;

function cacheGet(key: string) {
  const entry = tokenCache.get(key);
  if (!entry) return undefined;
  tokenCache.delete(key);
  tokenCache.set(key, entry);
  return entry.lines;
}

function cacheSet(key: string, lines: AgentCodeTokenLines) {
  const previous = tokenCache.get(key);
  if (previous) {
    tokenCacheChars -= previous.size;
    tokenCache.delete(key);
  }
  tokenCache.set(key, { lines, size: key.length });
  tokenCacheChars += key.length;
  for (const [oldest, entry] of tokenCache) {
    if (tokenCache.size <= MAX_CACHE_ENTRIES && tokenCacheChars <= MAX_CACHE_CHARS) break;
    tokenCache.delete(oldest);
    tokenCacheChars -= entry.size;
  }
}

function tokenCacheKey(code: string, language: AgentCodeLanguage) {
  return `${language}\u0000${code}`;
}

/**
 * Where tokenizing got to: every complete line (up to the last newline) with the
 * grammar state after it. Streaming code only grows, so each update tokenizes just
 * the new lines plus the partial last one, like t3code's incremental highlighting.
 */
interface Progress {
  readonly lang: BundledLanguage;
  /** Source up to and including its last newline. */
  readonly stable: string;
  /** Tokens of `stable`'s lines; they keep their identity, so memoized lines skip re-rendering. */
  readonly lines: AgentCodeTokenLines;
  readonly state: GrammarState | undefined;
}

function tokenizeChunk(
  h: Highlighter,
  code: string,
  lang: BundledLanguage,
  state: GrammarState | undefined,
  offset: number,
) {
  const raw = h.codeToTokensWithThemes(code, {
    lang,
    themes: THEMES,
    grammarState: state,
    tokenizeMaxLineLength: 1_000,
  });
  const lines = raw.map((line) =>
    line.map((token) => ({
      content: token.content,
      offset: token.offset + offset,
      light: token.variants.light?.color,
      dark: token.variants.dark?.color,
    })),
  );
  return { lines, state: h.getLastGrammarState(raw) };
}

/** Tokenizes `code`, continuing from `from` when `code` extends what it covered. */
function tokenize(h: Highlighter, code: string, lang: BundledLanguage, from: Progress | null) {
  let progress: Progress =
    from && from.lang === lang && code.startsWith(from.stable)
      ? from
      : { lang, stable: "", lines: [], state: undefined };
  const stableEnd = code.lastIndexOf("\n") + 1;
  if (stableEnd > progress.stable.length) {
    // The new complete lines, without their final newline.
    const chunk = tokenizeChunk(h, code.slice(progress.stable.length, stableEnd - 1), lang, progress.state, progress.stable.length);
    progress = { lang, stable: code.slice(0, stableEnd), lines: [...progress.lines, ...chunk.lines], state: chunk.state };
  }
  // The partial last line is tokenized from the saved state each time, and not kept.
  const tail = tokenizeChunk(h, code.slice(stableEnd), lang, progress.state, stableEnd).lines[0] ?? [];
  return { lines: [...progress.lines, tail], progress };
}

/**
 * Syntax tokens for `code`, or null while they aren't ready (render it plain).
 * Pass `streaming` while `code` is still being written: updates then tokenize only
 * what was added, and the result isn't cached until it's final.
 */
export function useAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
  streaming = false,
): AgentCodeTokenLines | null {
  const lang = code.length > MAX_HIGHLIGHT_CHARS ? "text" : readyLanguage(language);
  const key = tokenCacheKey(code, language);
  const progress = useRef<Progress | null>(null);
  const [, setLoaded] = useState(0);
  // Tokens computed after paint for a finished block seen for the first time.
  const [deferred, setDeferred] = useState<{ key: string; lines: AgentCodeTokenLines } | null>(null);

  const cached = lang === null || lang === "text" ? undefined : cacheGet(key);
  // Growing code picks up where the last update stopped; a finished block completes the same way.
  const continues =
    lang !== null && lang !== "text" && progress.current?.lang === lang && code.startsWith(progress.current.stable);

  const lines = useMemo(() => {
    if (lang === null || lang === "text" || !highlighter) return null;
    if (cached) return cached;
    if (!streaming && !continues) return null;
    const result = tokenize(highlighter, code, lang, progress.current);
    progress.current = result.progress;
    if (!streaming) cacheSet(key, result.lines);
    return result.lines;
  }, [cached, code, continues, key, lang, streaming]);

  useEffect(() => {
    if (lang === null) {
      let cancelled = false;
      void prepareLanguage(language).then(() => !cancelled && setLoaded((n) => n + 1));
      return () => {
        cancelled = true;
      };
    }
    if (lines || lang === "text" || !highlighter) return;
    // A finished block not seen before: tokenize after paint so opening a thread isn't held up.
    const h = highlighter;
    const timer = setTimeout(() => {
      const result = tokenize(h, code, lang, null);
      cacheSet(key, result.lines);
      setDeferred({ key, lines: result.lines });
    }, 0);
    return () => clearTimeout(timer);
  }, [code, key, lang, language, lines]);

  if (lines) return lines;
  return deferred?.key === key ? deferred.lines : null;
}

export const AgentCodeLine = memo(function AgentCodeLine({
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
});

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
