/** A failed git action in plain words, with what to do next; `detail` is git's own output. */
export interface GitFailure {
  readonly summary: string;
  readonly hint: string | null;
  readonly detail: string;
}

const KNOWN_FAILURES: ReadonlyArray<{ pattern: RegExp; summary: string; hint: string }> = [
  {
    pattern:
      /authentication failed|permission denied \(publickey|could not read (username|password)|terminal prompts disabled|invalid credentials|returned error: 40[13]/i,
    summary: "Git couldn't sign in to the remote.",
    hint: "Check your git credentials or SSH key, then retry.",
  },
  {
    pattern: /\[rejected\]|non-fast-forward|fetch first|updates were rejected/i,
    summary: "The remote has commits this branch doesn't have.",
    hint: "Pull them in (or ask the agent to rebase), then push again.",
  },
  {
    pattern: /has no upstream branch|no upstream configured/i,
    summary: "This branch isn't on the remote yet.",
    hint: "Retry: pushing publishes the branch.",
  },
  {
    pattern:
      /could not resolve host|unable to access|connection (refused|timed out|reset)|network is unreachable|operation timed out/i,
    summary: "Couldn't connect to the remote.",
    hint: "Check your internet connection, then retry.",
  },
  {
    pattern:
      /no such remote|does not appear to be a git repository|repository .*not found|could not read from remote repository/i,
    summary: "Couldn't find the remote repository.",
    hint: "Check the remote's URL with `git remote -v`, and that you have access to it.",
  },
  {
    pattern: /gh auth login|glab auth login|not logged in/i,
    summary: "The GitHub or GitLab CLI isn't signed in.",
    hint: "Sign in under Settings → Git, then retry.",
  },
  {
    pattern: /conflict/i,
    summary: "The merge has conflicts.",
    hint: "Resolve them in the folder (or ask the agent to), then retry.",
  },
];

export function describeGitFailure(error: string): GitFailure {
  const known = KNOWN_FAILURES.find((failure) => failure.pattern.test(error));

  if (known) return { summary: known.summary, hint: known.hint, detail: error };

  // MassCode's own messages are already plain; git's start with "fatal:" or "error:".
  const firstLine = error
    .split("\n")[0]
    .replace(/^(fatal|error|remote):\s*/i, "")
    .trim();

  return {
    summary: `${firstLine.charAt(0).toUpperCase()}${firstLine.slice(1)}`,
    hint: null,
    detail: error,
  };
}
