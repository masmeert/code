/**
 * Which skills each harness loads per folder, as the harness itself reports them, and the `$name`
 * mentions that run them. Scanning skill folders ourselves would mean copying each harness's
 * lookup rules (scopes, plugins, overrides), which change with every release.
 */
import { PROVIDER_NAME, type ProviderKind } from "@masscode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ProviderError, ProviderSkill } from "./providers/ProviderAdapter.ts";

/** Asking a harness takes seconds (Claude starts a process), so a listing is reused this long before a refresh. */
const FRESH_MS = 30_000;

/** `$name` at the start or after whitespace. Only known names count, so `$HOME` or `$20` stay prose. */
const MENTION = /(^|\s)\$([A-Za-z0-9][\w:-]*)(?![\w:-])/g;

interface SkillMention {
  readonly skill: ProviderSkill;
  /** Where the `$` is. */
  readonly start: number;
  readonly end: number;
}

export function skillMentions(
  text: string,
  skills: ReadonlyArray<ProviderSkill>,
): Array<SkillMention> {
  return [...text.matchAll(MENTION)].flatMap((match) => {
    const skill = skills.find((candidate) => candidate.name === match[2]);
    if (!skill) return [];

    const start = match.index + match[1]!.length;
    return [{ skill, start, end: match.index + match[0].length }];
  });
}

interface SkillListing {
  readonly skills: ReadonlyArray<ProviderSkill>;
  readonly error: string | null;
  readonly listedAtMs: number;
}

export function createSkillCatalog(options: {
  readonly read: (
    provider: ProviderKind,
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<ProviderSkill>, ProviderError>;
  /** Called with every listing a client hasn't seen yet. */
  readonly onListed: (provider: ProviderKind, cwd: string, listing: SkillListing) => void;
}) {
  const listings = new Map<string, SkillListing>();
  const reading = new Map<string, Promise<SkillListing>>();

  function refresh(provider: ProviderKind, cwd: string) {
    const key = `${provider}:${cwd}`;
    const inFlight = reading.get(key);
    if (inFlight) return inFlight;

    const next = Effect.runPromise(
      options.read(provider, cwd).pipe(
        // A defect would reject, leaving the key's in-flight read stuck on it.
        Effect.matchCause({
          onSuccess: (skills) => ({ skills, error: null }),
          onFailure: (cause) => {
            const error = Cause.squash(cause);
            return {
              skills: listings.get(key)?.skills ?? [],
              error: `Couldn't read ${PROVIDER_NAME[provider]}'s skills: ${error instanceof Error ? error.message : String(error)}`,
            };
          },
        }),
      ),
    ).then((result) => {
      reading.delete(key);

      const previous = listings.get(key);
      const listing = { ...result, listedAtMs: Date.now() };
      listings.set(key, listing);
      if (
        !previous ||
        previous.error !== listing.error ||
        JSON.stringify(previous.skills) !== JSON.stringify(listing.skills)
      )
        options.onListed(provider, cwd, listing);

      return listing;
    });

    reading.set(key, next);
    return next;
  }

  /** The last listing, or a first one read now. */
  async function latest(provider: ProviderKind, cwd: string) {
    return listings.get(`${provider}:${cwd}`) ?? (await refresh(provider, cwd));
  }

  return {
    /** Answers from the last listing at once, then refreshes it if it's old; a new listing is announced when it differs. */
    request(provider: ProviderKind, cwd: string) {
      const listing = listings.get(`${provider}:${cwd}`);
      if (listing) options.onListed(provider, cwd, listing);
      if (!listing || Date.now() - listing.listedAtMs > FRESH_MS) void refresh(provider, cwd);
    },
    /** The skills `text` mentions, from the listing the menu showed. */
    async mentionedIn(provider: ProviderKind, cwd: string, text: string) {
      if (!/\$[A-Za-z0-9]/.test(text)) return [];

      const { skills } = await latest(provider, cwd);
      return [...new Set(skillMentions(text, skills).map((mention) => mention.skill))];
    },
    /** Names of the skills the menu shows, for keeping them out of the command menu. */
    async names(provider: ProviderKind, cwd: string) {
      const { skills } = await latest(provider, cwd);
      return new Set(skills.map((skill) => skill.name));
    },
  };
}
