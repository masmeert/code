/**
 * Which skills each harness loads per folder, as the harness itself reports them, and the `$name`
 * mentions that run them. Scanning skill folders ourselves would mean copying each harness's
 * lookup rules (scopes, plugins, overrides), which change with every release.
 */
import { PROVIDER_NAME, type ProviderKind } from "@masscode/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type { ProviderError, ProviderSkill } from "./providers/ProviderAdapter.ts";
import { getErrorMessage } from "./errors.ts";

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

export function findSkillMentions(
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

/** A scoped catalog: reads still going when its scope closes are interrupted. */
export const createSkillCatalog = Effect.fn("createSkillCatalog")(function* (options: {
  readonly readSkills: (
    provider: ProviderKind,
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<ProviderSkill>, ProviderError>;
  /** Called with every listing a client hasn't seen yet. */
  readonly onListed: (provider: ProviderKind, cwd: string, listing: SkillListing) => void;
}) {
  const runFork = yield* FiberSet.makeRuntime();
  const listings = new Map<string, SkillListing>();
  const reading = new Map<string, Deferred.Deferred<SkillListing>>();

  /** Asks the harness for its skills, keeping the last ones when it can't say. */
  function readListing(provider: ProviderKind, cwd: string, key: string) {
    return options.readSkills(provider, cwd).pipe(
      // Defects too: a listing that can't be read mustn't fail the message mentioning a skill.
      Effect.matchCause({
        onSuccess: (skills) => ({ skills, error: null }),
        onFailure: (cause) => ({
          skills: listings.get(key)?.skills ?? [],
          error: `Couldn't read ${PROVIDER_NAME[provider]}'s skills: ${getErrorMessage(Cause.squash(cause))}`,
        }),
      }),
      Effect.map((result) => {
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
      }),
    );
  }

  /** Starts reading the listing, unless a read is already going; either way, resolves with it. */
  function refreshListing(provider: ProviderKind, cwd: string) {
    const key = `${provider}:${cwd}`;
    const inFlight = reading.get(key);
    if (inFlight) return inFlight;

    const read = Deferred.makeUnsafe<SkillListing>();
    reading.set(key, read);
    runFork(
      readListing(provider, cwd, key).pipe(
        Effect.ensuring(Effect.sync(() => reading.delete(key))),
        Deferred.into(read),
      ),
    );
    return read;
  }

  /** The last listing, or a first one read now. */
  function loadListing(provider: ProviderKind, cwd: string) {
    return Effect.suspend(() => {
      const listing = listings.get(`${provider}:${cwd}`);
      return listing ? Effect.succeed(listing) : Deferred.await(refreshListing(provider, cwd));
    });
  }

  return {
    /** Answers from the last listing at once, then refreshes it if it's old; a new listing is announced when it differs. */
    requestListing(provider: ProviderKind, cwd: string) {
      const listing = listings.get(`${provider}:${cwd}`);
      if (listing) options.onListed(provider, cwd, listing);
      if (!listing || Date.now() - listing.listedAtMs > FRESH_MS) refreshListing(provider, cwd);
    },
    /** The skills `text` mentions, from the listing the menu showed. */
    findMentionedSkills: Effect.fn("findMentionedSkills")(function* (
      provider: ProviderKind,
      cwd: string,
      text: string,
    ) {
      if (!/\$[A-Za-z0-9]/.test(text)) return [];

      const { skills } = yield* loadListing(provider, cwd);
      return [...new Set(findSkillMentions(text, skills).map((mention) => mention.skill))];
    }),
    /** Names of the skills the menu shows, for keeping them out of the command menu. */
    loadSkillNames: Effect.fn("loadSkillNames")(function* (provider: ProviderKind, cwd: string) {
      const { skills } = yield* loadListing(provider, cwd);
      return new Set(skills.map((skill) => skill.name));
    }),
  };
});
