// Fuzzy command search. Each item's fields are normalized once and cached, so a
// keystroke only scores.

export type SearchableCommand = {
  readonly label: string;
  readonly group?: string;
  readonly keywords?: ReadonlyArray<string>;
};

function normalize(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type Field = { text: string; words: string[] };

/**
 * Keyed by the item object, so it holds for as long as the caller keeps passing
 * the same objects. An item whose text changes must be a new object.
 */
const fieldCache = new WeakMap<SearchableCommand, ReadonlyArray<Field>>();

/** The label first: it earns a bonus the other fields don't. */
function fieldsOf(item: SearchableCommand) {
  let fields = fieldCache.get(item);
  if (!fields) {
    fields = [item.label, item.group ?? "", ...(item.keywords ?? [])].map((value) => {
      const text = normalize(value);
      return { text, words: text.split(" ") };
    });
    fieldCache.set(item, fields);
  }
  return fields;
}

function tokenScore(token: string, { text, words }: Field) {
  if (words.includes(token)) return 100;
  if (words.some((word) => word.startsWith(token))) return 80;
  if (text.includes(token)) return 60;
  // Keep short queries precise; fuzzy abbreviations may skip at most two
  // letters within a word, rather than matching across a whole description.
  if (token.length < 3) return 0;
  for (const word of words) {
    if (word.length - token.length > 2) continue;
    let matched = 0;
    for (const char of word) {
      if (char === token[matched]) matched++;
    }
    if (matched === token.length) return 20;
  }
  return 0;
}

/**
 * Match every query word across fields and put direct name matches first. Equal
 * scores keep the order they came in.
 */
export function searchCommands<T extends SearchableCommand>(
  items: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const normalized = normalize(query);
  if (!normalized) return items;
  const tokens = normalized.split(" ");
  const matches: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const fields = fieldsOf(item);
    const label = fields[0].text;
    let score = label === normalized ? 10000 : label.startsWith(normalized) ? 2000 : 0;
    for (const token of tokens) {
      let best = 0;
      for (let index = 0; index < fields.length; index++) {
        const match = tokenScore(token, fields[index]);
        if (match) best = Math.max(best, match + (index === 0 ? 40 : 0));
      }
      if (!best) {
        score = 0;
        break;
      }
      score += best;
    }
    if (score > 0) matches.push({ item, score });
  }
  return matches.sort((a, b) => b.score - a.score).map(({ item }) => item);
}
