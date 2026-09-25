/**
 * Pull requests through the hosts' own CLIs: `gh` for GitHub, `glab` for GitLab (where
 * they're merge requests). Sign-in belongs to the CLIs; we only read it. Follows t3code.
 */
import type {
  MergeMethod,
  PullRequest,
  SourceControlKind,
  SourceControlStatus,
} from "@apcode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const CLI: Record<SourceControlKind, { bin: string; label: string; install: string }> = {
  github: { bin: "gh", label: "GitHub", install: "Install it from https://cli.github.com" },
  gitlab: {
    bin: "glab",
    label: "GitLab",
    install: "Install it from https://gitlab.com/gitlab-org/cli",
  },
};

interface CliResult {
  readonly ok: boolean;
  /** Null when the CLI isn't on PATH. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  kind: SourceControlKind,
  args: ReadonlyArray<string>,
  cwd?: string,
  timeoutMs = 30_000,
) {
  return new Promise<CliResult>((resolve) =>
    execFile(
      CLI[kind].bin,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          code: error ? (error.code === "ENOENT" ? null : Number(error.code) || 1) : 0,
          stdout: String(stdout).trim(),
          // Auth output may echo token scopes; never pass those on.
          stderr: String(stderr)
            .split("\n")
            .filter((line) => !/^[-\s]*token(?:\s+scopes?)?:/i.test(line))
            .join("\n")
            .trim(),
        }),
    ),
  );
}

const firstLine = (text: string) => text.split("\n").find(Boolean) ?? "";

const GitHubAuth = Schema.Struct({
  hosts: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        state: Schema.String,
        active: Schema.optional(Schema.Boolean),
        login: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
      }),
    ),
  ),
});

async function probeOne(kind: SourceControlKind): Promise<SourceControlStatus> {
  const { label, install, bin } = CLI[kind];
  const version = await run(kind, ["--version"], undefined, 5000);
  if (!version.ok)
    return {
      kind,
      installed: false,
      version: null,
      authenticated: null,
      account: null,
      detail: `\`${bin}\` isn't on your PATH. ${install}.`,
    };
  const base = { kind, installed: true, version: firstLine(version.stdout || version.stderr) };
  const signIn = `Run \`${bin} auth login\` in a terminal to sign in.`;

  if (kind === "github") {
    const auth = await run(kind, ["auth", "status", "--json", "hosts"], undefined, 10_000);
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubAuth))(auth.stdout);
    if (Option.isNone(parsed))
      return {
        ...base,
        authenticated: auth.stderr.includes("unknown flag: --json") ? null : false,
        account: null,
        detail: auth.stderr.includes("unknown flag: --json")
          ? "Your gh is too old to check sign-in. Update it to 2.81 or newer."
          : `${label} isn't signed in. ${signIn}`,
      };
    const accounts = Object.values(parsed.value.hosts).flat();
    const account =
      accounts.find((entry) => entry.state === "success" && entry.active) ??
      accounts.find((entry) => entry.state === "success");
    return account
      ? { ...base, authenticated: true, account: account.login ?? null, detail: null }
      : {
          ...base,
          authenticated: false,
          account: null,
          detail: `${label} isn't signed in. ${signIn}`,
        };
  }

  const auth = await run(kind, ["auth", "status"], undefined, 10_000);
  const account = gitLabAccounts(`${auth.stdout}\n${auth.stderr}`)[0]?.account ?? null;
  return account
    ? { ...base, authenticated: true, account, detail: null }
    : {
        ...base,
        authenticated: false,
        account: null,
        detail: `${label} isn't signed in. ${signIn}`,
      };
}

/** Hosts `glab auth status` reports as signed in, with their account. */
function gitLabAccounts(output: string) {
  const found: Array<{ host: string; account: string }> = [];
  let host = "";
  for (const line of output.split("\n")) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(line.trim()) && !/^\s/.test(line)) host = line.trim();
    const account = line.match(/Logged in to (\S+) as\s+([^\s(]+)/i);
    if (account) found.push({ host: account[1] ?? host, account: account[2]! });
  }
  return found;
}

export const probeSourceControl = () => Promise.all([probeOne("github"), probeOne("gitlab")]);

function remoteHost(url: string) {
  const scp = url.match(/^[^@/]+@([^:]+):/);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Which host a remote URL is on; self-hosted GitLab counts when glab is signed in to it. */
export async function detectSourceControl(url: string | null): Promise<SourceControlKind | null> {
  const host = url ? remoteHost(url) : null;
  if (!host) return null;
  const labels = host.split(".");
  if (host === "github.com" || labels.includes("github")) return "github";
  if (host === "gitlab.com" || labels.includes("gitlab")) return "gitlab";
  const auth = await run("gitlab", ["auth", "status"], undefined, 5000);
  return gitLabAccounts(`${auth.stdout}\n${auth.stderr}`).some((entry) => entry.host === host)
    ? "gitlab"
    : null;
}

const GitHubPullRequests = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    url: Schema.String,
    title: Schema.String,
    state: Schema.String,
    isDraft: Schema.Boolean,
    baseRefName: Schema.String,
  }),
);

const GitLabMergeRequests = Schema.Array(
  Schema.Struct({
    iid: Schema.Number,
    web_url: Schema.String,
    title: Schema.String,
    state: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    target_branch: Schema.String,
  }),
);

/** The branch's open pull request, else its most recent one; null when it has none or the CLI can't tell. */
export async function readPullRequest(
  cwd: string,
  kind: SourceControlKind,
  branch: string,
): Promise<PullRequest | null> {
  if (kind === "github") {
    const listed = await run(
      kind,
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "20",
        "--json",
        "number,url,title,state,isDraft,baseRefName",
      ],
      cwd,
    );
    const prs = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubPullRequests))(
      listed.stdout,
    );
    if (Option.isNone(prs)) return null;
    // gh lists newest first.
    const pr = prs.value.find((entry) => entry.state === "OPEN") ?? prs.value[0];
    if (!pr) return null;
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title,
      state:
        pr.state === "MERGED"
          ? "merged"
          : pr.state === "CLOSED"
            ? "closed"
            : pr.isDraft
              ? "draft"
              : "open",
      base: pr.baseRefName,
    };
  }
  const listed = await run(
    kind,
    ["mr", "list", "--source-branch", branch, "--all", "--per-page", "20", "--output", "json"],
    cwd,
  );
  const mrs = Schema.decodeUnknownOption(Schema.fromJsonString(GitLabMergeRequests))(listed.stdout);
  if (Option.isNone(mrs)) return null;
  const mr = mrs.value.find((entry) => entry.state === "opened") ?? mrs.value[0];
  if (!mr) return null;
  return {
    number: mr.iid,
    url: mr.web_url,
    title: mr.title,
    state:
      mr.state === "merged"
        ? "merged"
        : mr.state === "closed"
          ? "closed"
          : mr.draft
            ? "draft"
            : "open",
    base: mr.target_branch,
  };
}

/** Opens the pull request; resolves to an error message on failure. */
export async function openPullRequest(
  cwd: string,
  kind: SourceControlKind,
  request: { base: string; head: string; title: string; body: string },
) {
  const result =
    kind === "github"
      ? await run(
          kind,
          [
            "pr",
            "create",
            "--base",
            request.base,
            "--head",
            request.head,
            "--title",
            request.title,
            "--body",
            request.body,
          ],
          cwd,
          60_000,
        )
      : await run(
          kind,
          [
            "mr",
            "create",
            "--source-branch",
            request.head,
            "--target-branch",
            request.base,
            "--title",
            request.title,
            "--description",
            request.body,
            "--yes",
          ],
          cwd,
          60_000,
        );
  return result.ok
    ? null
    : firstLine(result.stderr || result.stdout) || "Couldn't open the pull request";
}

const MERGE_FLAG: Record<MergeMethod, string> = {
  merge: "--merge",
  squash: "--squash",
  rebase: "--rebase",
};

/** Merges pull request `number` on its host; resolves to an error message on failure. */
export async function mergePullRequest(
  cwd: string,
  kind: SourceControlKind,
  number: number,
  method: MergeMethod,
) {
  const result =
    kind === "github"
      ? await run(kind, ["pr", "merge", String(number), MERGE_FLAG[method]], cwd, 60_000)
      : await run(
          kind,
          [
            "mr",
            "merge",
            String(number),
            "--yes",
            "--auto-merge=false",
            ...(method === "merge" ? [] : [MERGE_FLAG[method]]),
          ],
          cwd,
          60_000,
        );
  return result.ok
    ? null
    : firstLine(result.stderr || result.stdout) || "Couldn't merge the pull request";
}

const TEMPLATE_FILES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];
const TEMPLATE_DIRS = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
];

/** The repo's pull request template (GitHub layout), or null; a folder of several is ambiguous, so none. */
export async function readPullRequestTemplate(root: string) {
  for (const file of TEMPLATE_FILES) {
    const text = await readFile(join(root, file), "utf8").catch(() => null);
    if (text !== null) return text.slice(0, 8000);
  }
  for (const dir of TEMPLATE_DIRS) {
    const entries = await readdir(join(root, dir)).catch(() => []);
    const templates = entries.filter((name) => name.endsWith(".md"));
    if (templates.length === 1)
      return (await readFile(join(root, dir, templates[0]!), "utf8")).slice(0, 8000);
  }
  return null;
}
