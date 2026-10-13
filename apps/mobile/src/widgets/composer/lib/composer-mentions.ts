/** A file mention or skill the editor draws as one chip, at `start..end` of the draft. */
export interface ComposerInlineToken {
  readonly type: "mention" | "skill";
  /** The path or skill name. */
  readonly value: string;
  /** The text the chip stands for, which is what the message sends. */
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

/**
 * A skill name may start with a digit, but compact monetary amounts and
 * numeric expressions like "$20", "$20k", "$100M", and "$1e6" must stay prose:
 * the composer chips any matched `$name` token, known or not. Tokens beginning
 * with digits must not match numbers with currency/exponent suffixes, and must
 * contain at least one letter. Any currency symbol is accepted as the sigil.
 */
const SKILL_MENTION_SOURCE =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)/u
    .source;

// While typing, a token only becomes a chip once a delimiter follows it, so a
// half-typed name at the end of the text stays plain.
const SKILL_TOKEN_REGEX = new RegExp(`${SKILL_MENTION_SOURCE}(?=\\s)`, "gu");

// `@path`, or `@"path with spaces"` as the file menu writes it.
const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;

function collectTokens(
  text: string,
  type: ComposerInlineToken["type"],
  regex: RegExp,
): Array<ComposerInlineToken> {
  return Array.from(text.matchAll(regex)).flatMap((match) => {
    const prefix = match[1] ?? "";
    const value = (match[2]?.replace(/\\(.)/g, "$1") ?? match[3]) || "";

    if (!value) return [];

    const start = (match.index ?? 0) + prefix.length;
    const end = start + match[0].length - prefix.length;

    return [{ type, value, source: text.slice(start, end), start, end }];
  });
}

/**
 * The chips in `text`. A chip at the very end has no delimiter after it yet, so `confirmed`, the
 * last call's result, keeps one that was already a chip (say, the space after it was deleted).
 */
export function collectComposerInlineTokens(
  text: string,
  confirmed: ReadonlyArray<ComposerInlineToken> = [],
): ReadonlyArray<ComposerInlineToken> {
  const matches = [
    ...collectTokens(text, "mention", MENTION_TOKEN_REGEX),
    ...collectTokens(text, "skill", SKILL_TOKEN_REGEX),
  ];

  for (const token of confirmed)
    if (
      token.end === text.length &&
      text.slice(token.start, token.end) === token.source &&
      !matches.some(
        (match) =>
          match.type === token.type && match.start === token.start && match.end === token.end,
      )
    )
      matches.push(token);

  return matches.sort((left, right) => left.start - right.start);
}

/** What the word at the caret asks the menu for; `typedLength` counts its characters before the caret. */
export interface ComposerTrigger {
  readonly kind: "command" | "skill" | "file";
  readonly query: string;
  readonly typedLength: number;
}

/**
 * As on the desktop: "/" opens commands only as the whole draft, "$" skills and "@" files at the
 * start or after whitespace. A letter must follow "$", so prices like "$20" never open the menu.
 */
export function detectComposerTrigger(text: string, caret: number): ComposerTrigger | null {
  if (/^\/\S*$/.test(text)) return { kind: "command", query: text.slice(1), typedLength: caret };

  const beforeCaret = text.slice(0, caret);
  const skill = /(?:^|\s)\$((?:[A-Za-z][\w:-]*)?)$/.exec(beforeCaret);

  if (skill) return { kind: "skill", query: skill[1], typedLength: skill[1].length + 1 };

  const file = /(?:^|\s)@(\S*)$/.exec(beforeCaret);

  return file ? { kind: "file", query: file[1], typedLength: file[1].length + 1 } : null;
}

/** Swaps the word at the caret, `typedLength` characters of which are before it, for `token`. */
export function replaceTypedWord(text: string, caret: number, typedLength: number, token: string) {
  const start = caret - typedLength;
  const end = caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  const rest = text.slice(end).replace(/^ +/, "");

  return { text: text.slice(0, start) + token + rest, caret: start + token.length };
}

/** The text a picked file puts in the message; quoted so a path with spaces reads as one mention. */
export function formatFileMention(path: string) {
  return /\s/.test(path) ? `@"${path}" ` : `@${path} `;
}

/** Best matches first: the file name starting with the query, then containing it, then the path. */
export function matchFiles(files: ReadonlyArray<string>, query: string) {
  const lowercaseQuery = query.toLowerCase();

  function getMatchRank(path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();

    return name.startsWith(lowercaseQuery) ? 0 : name.includes(lowercaseQuery) ? 1 : 2;
  }

  return files
    .flatMap((path) =>
      path.toLowerCase().includes(lowercaseQuery) ? [{ path, rank: getMatchRank(path) }] : [],
    )
    .sort((first, second) => first.rank - second.rank || first.path.length - second.path.length)
    .slice(0, 50)
    .map(({ path }) => path);
}

/** Stable, human-readable names when a draft holds several folded pastes. */
export function nextPastedTextFileName(existingNames: ReadonlyArray<string>) {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));

  if (!names.has("pasted-text.txt")) return "pasted-text.txt";

  for (let sequence = 2; ; sequence += 1)
    if (!names.has(`pasted-text-${sequence}.txt`)) return `pasted-text-${sequence}.txt`;
}
