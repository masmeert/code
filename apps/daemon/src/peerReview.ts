/**
 * The first message of a peer review: one harness's agent checking another's work. The reviewer
 * starts cold, so the message carries what the user asked, what the author said it did, and a
 * pinned git range of what changed.
 */
import { type ProviderKind, RuntimeEvent, type Settings } from "@apcode/contracts";

type Message = Extract<RuntimeEvent, { _tag: "user.message" | "assistant.completed" }>;

/** Enough to go on; the reviewer reads the code itself. */
const MAX_REQUEST_CHARS = 4_000;
const MAX_FOLLOW_UP_CHARS = 1_000;
const MAX_FOLLOW_UPS = 8;
const MAX_REPLY_CHARS = 6_000;

/** The harness's name as the user set it in Settings, else its own; the same one the app shows. */
export function harnessName(settings: Settings, provider: ProviderKind) {
  return (
    settings.providers[provider].displayName?.trim() ||
    ({ claude: "Claude", codex: "Codex" } as const)[provider]
  );
}

function clip(text: string, maxChars: number) {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}\n[…cut]` : trimmed;
}

export function peerReviewPrompt(input: {
  readonly author: string;
  readonly messages: ReadonlyArray<Message>;
  readonly range: {
    readonly start: string;
    readonly end: string;
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
  } | null;
}) {
  const { author, range } = input;
  const asks = input.messages.filter(
    (message): message is Extract<Message, { _tag: "user.message" }> =>
      RuntimeEvent.guards["user.message"](message) && message.text.trim() !== "",
  );
  const followUps = asks.slice(1);
  const shownFollowUps = followUps.slice(-MAX_FOLLOW_UPS);
  const reply = input.messages.findLast(
    (message) => RuntimeEvent.guards["assistant.completed"](message) && message.text.trim() !== "",
  );
  return [
    `You're reviewing work that ${author}, another coding agent, did in this folder. Be the second pair of eyes that catches what's wrong before it ships.`,
    "Don't edit files, commit, or run anything that changes state: read the code and run read-only commands only.",
    `## What the user asked ${author}`,
    asks[0] ? clip(asks[0].text, MAX_REQUEST_CHARS) : "(Nothing in writing.)",
    ...(shownFollowUps.length
      ? [
          "## Their follow-ups, in order",
          ...(followUps.length > shownFollowUps.length
            ? [`(${followUps.length - shownFollowUps.length} earlier ones left out.)`]
            : []),
          shownFollowUps
            .map(
              (message) => `- ${clip(message.text, MAX_FOLLOW_UP_CHARS).replaceAll("\n", "\n  ")}`,
            )
            .join("\n"),
        ]
      : []),
    `## What ${author} said when it finished`,
    reply ? clip(reply.text, MAX_REPLY_CHARS) : "(It didn't reply.)",
    "## The changes",
    range === null
      ? "There are no snapshots of this thread's work, so this may not be a git repo. Work out what changed from `git status` and `git diff` if it is one, or from the files the reply mentions."
      : range.files === 0
        ? "The thread's snapshots show no file changes, so review the answer itself: check what it claims against the code."
        : `Run \`git diff ${range.start} ${range.end}\` to see everything the thread changed (${range.files} file${range.files === 1 ? "" : "s"}, +${range.additions} −${range.deletions}). Both refs are snapshots of the working tree, new files included; the files may have moved on since.`,
    "## What to report",
    "Findings, most severe first. For each: the file and line, what goes wrong and when, and the fix you'd make.",
    "Look for bugs and regressions, requests that weren't met or were misread, unhandled edge cases and errors, and anything the reply claims that the code doesn't do.",
    `Leave out style preferences and nitpicks. If something looks right, say so plainly rather than inventing problems. Your report goes back to ${author}, so write it for them.`,
    'End with one line: "Verdict: ready" or "Verdict: needs changes".',
  ].join("\n\n");
}
