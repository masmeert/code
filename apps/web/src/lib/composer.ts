import {
  type Attachment,
  AttachmentInput,
  type Effort,
  type PermissionLevel,
  type ProviderKind,
  type TurnOptions,
} from "@masscode/contracts";
import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import { type DraftAttachment, getDraft, setDraft, useDraft } from "./drafts.ts";
import { firstTurnOptions, respondApproval, useStore } from "./store.ts";

/** Efforts each harness can take, lowest first; a model's own list narrows it. */
export const EFFORTS: Record<ProviderKind, ReadonlyArray<Effort>> = {
  claude: ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  cursor: ["minimal", "low", "medium", "high", "xhigh", "max"],
};

export const EFFORT_LABEL: Record<Effort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};

/**
 * Permission levels each harness offers, safest first; Codex has no plan or auto mode. Cursor edits
 * without asking, so it can't offer "ask first".
 */
export const PERMISSIONS: Record<ProviderKind, ReadonlyArray<PermissionLevel>> = {
  claude: ["plan", "ask", "auto-edit", "auto", "full-access"],
  codex: ["ask", "auto-edit", "full-access"],
  cursor: ["plan", "auto-edit", "full-access"],
};

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  plan: "Plan",
  ask: "Ask first",
  "auto-edit": "Auto-edit",
  auto: "Auto",
  "full-access": "Full access",
};

export const PERMISSION_DESCRIPTION: Record<PermissionLevel, string> = {
  plan: "Reads and plans without changing anything, then asks you to approve the plan",
  ask: "Asks before running commands or editing files",
  "auto-edit": "Edits files freely, asks before riskier commands",
  auto: "A classifier approves safe actions and blocks risky ones, without asking",
  "full-access": "Runs anything without asking, outside the sandbox too",
};

interface TurnPrefs {
  /** Null leaves it to the harness. */
  readonly effort: Effort | null;
  readonly fast: boolean;
  readonly permission: PermissionLevel;
}

// Each thread keeps its own picks while the window is open; new ones start from Settings.
const perThread = new Map<string, Partial<TurnPrefs>>();
const prefsListeners = new Set<() => void>();

function onPrefsChange(listener: () => void) {
  prefsListeners.add(listener);
  return () => prefsListeners.delete(listener);
}

function setTurnPrefs(key: string, patch: Partial<TurnPrefs>) {
  perThread.set(key, { ...perThread.get(key), ...patch });
  for (const listener of prefsListeners) listener();
}

/**
 * Drops what the harness doesn't take (e.g. "max" effort or plan mode after switching a draft to
 * Codex), and Full access on a root host that isn't allowed yet.
 */
function fit(prefs: TurnPrefs, provider: ProviderKind, needsRootConsent: boolean): TurnPrefs {
  return {
    fast: prefs.fast,
    effort: prefs.effort && EFFORTS[provider].includes(prefs.effort) ? prefs.effort : null,
    permission:
      PERMISSIONS[provider].includes(prefs.permission) &&
      !(needsRootConsent && prefs.permission === "full-access")
        ? prefs.permission
        : // Every harness offers a level besides plan.
          PERMISSIONS[provider].find((level) => level !== "plan")!,
  };
}

/** Effort and permission level for the composer identified by `key` (a thread id, or a draft's path). */
export function useTurnPrefs(key: string, provider: ProviderKind, host: string | null) {
  const stored = useSyncExternalStore(onPrefsChange, () => perThread.get(key));
  const settings = useStore((state) => state.settings);
  const needsRootConsent = useNeedsRootConsent(host);
  const first = firstTurnOptions(key);
  const prefs = fit(
    {
      effort: settings.newThreadEffort ?? null,
      fast: false,
      permission: settings.newThreadPermission ?? "ask",
      ...(first && {
        effort: first.effort,
        fast: first.fast ?? false,
        permission: first.permission,
      }),
      ...stored,
    },
    provider,
    needsRootConsent,
  );
  return [prefs, (patch: Partial<TurnPrefs>) => setTurnPrefs(key, { ...prefs, ...patch })] as const;
}

// A daemon running as root lets Full access change anything on its machine, so each such host
// needs a one-time OK first.
function rootConsentKey(host: string) {
  return `masscode.fullAccessAsRoot.${host}`;
}

/** Whether Full access on `host` still waits for that OK. */
export function useNeedsRootConsent(host: string | null) {
  const root = useStore((state) => host !== null && state.hosts[host]?.root === true);
  const allowed = useSyncExternalStore(
    onPrefsChange,
    () => host !== null && localStorage.getItem(rootConsentKey(host)) === "1",
  );
  return root && !allowed;
}

export function allowFullAccessAsRoot(host: string) {
  localStorage.setItem(rootConsentKey(host), "1");
  for (const listener of prefsListeners) listener();
}

export function forgetFullAccessAsRoot(host: string) {
  localStorage.removeItem(rootConsentKey(host));
}

/** Labels for approving a plan into each level it can be built with. */
export const BUILD_WITH_LABEL = {
  ask: "Approve and ask before edits",
  "auto-edit": "Approve and allow edits",
  auto: "Approve and auto mode",
  "full-access": "Approve and bypass permissions",
} as const satisfies Record<Exclude<PermissionLevel, "plan">, string>;

/** Approves a plan: the daemon leaves plan mode for `permission`, and the thread's composer follows. */
export function approvePlan(
  threadId: string,
  requestId: string,
  permission: keyof typeof BUILD_WITH_LABEL,
) {
  respondApproval(threadId, requestId, "allow", { permission });
  setTurnPrefs(threadId, { permission });
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

function fromPath(path: string): DraftAttachment {
  return {
    id: crypto.randomUUID(),
    name: path.split(/[\\/]/).at(-1) ?? path,
    image: IMAGE_NAME.test(path),
    input: AttachmentInput.cases.path.make({ path }),
  };
}

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function fromFile(file: File): Promise<DraftAttachment> {
  const image = file.type.startsWith("image/");
  const name =
    file.name || (image ? `Pasted image.${file.type.split("/")[1] ?? "png"}` : "Pasted file");
  return {
    id: crypto.randomUUID(),
    name,
    image,
    preview: image ? URL.createObjectURL(file) : undefined,
    input: AttachmentInput.cases.data.make({
      name,
      mediaType: file.type || "application/octet-stream",
      data: await readBase64(file),
    }),
  };
}

/** A sent message's files, back in a composer (they're on disk by then). */
export function fromSent(attachment: Attachment): DraftAttachment {
  return fromPath(attachment.path);
}

/** Past this, pasted text becomes an attached file instead of flooding the prompt (t3code uses 32 KiB too). */
export const LARGE_PASTE_BYTES = 32 * 1024;

function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // Chunked so the spread stays under the engine's argument limit.
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Pasted text as a file the agent can read. */
export function fromText(text: string): DraftAttachment {
  const name = `Pasted text (${Math.max(1, Math.round(text.length / 1024))} KB).txt`;
  return {
    id: crypto.randomUUID(),
    name,
    image: false,
    input: AttachmentInput.cases.data.make({ name, mediaType: "text/plain", data: toBase64(text) }),
  };
}

/** Picked or dropped files; a remote host can't read this Mac's paths, so they go as data. */
async function fromPaths(paths: ReadonlyArray<string>, remote: boolean) {
  if (!remote || !window.desktop) return paths.map(fromPath);
  return (await window.desktop.readFiles(paths)).map((input): DraftAttachment => ({
    id: crypto.randomUUID(),
    name: input.name,
    image: input.mediaType.startsWith("image/"),
    preview: input.mediaType.startsWith("image/")
      ? `data:${input.mediaType};base64,${input.data}`
      : undefined,
    input,
  }));
}

/** Files queued for the next message of composer `key`: picked, pasted, or dropped onto the window. */
export function useAttachments({
  key,
  acceptDrops,
  remote,
}: {
  key: string;
  acceptDrops: boolean;
  /** The composer's thread runs on a remote host. */
  remote: boolean;
}) {
  const attachments = useDraft(key).attachments;
  const inputRef = useRef<HTMLInputElement | null>(null);

  function setAttachments(
    update: (prev: ReadonlyArray<DraftAttachment>) => ReadonlyArray<DraftAttachment>,
  ) {
    setDraft(key, (draft) => ({ ...draft, attachments: update(draft.attachments) }));
  }

  function add(next: ReadonlyArray<DraftAttachment>) {
    setAttachments((prev) => [...prev, ...next]);
  }

  function revoke(list: ReadonlyArray<DraftAttachment>) {
    for (const attachment of list) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
  }

  async function addFiles(files: ReadonlyArray<File>) {
    add(await Promise.all(files.map(fromFile)));
  }

  async function pick() {
    if (!window.desktop) {
      // Browsers can't hand out paths, so files travel as data.
      const input =
        inputRef.current ??
        Object.assign(document.createElement("input"), { type: "file", multiple: true });
      inputRef.current = input;
      input.onchange = () => {
        void addFiles([...(input.files ?? [])]);
        input.value = "";
      };
      input.click();
      return;
    }

    add(await fromPaths(await window.desktop.pickFiles("Attach files"), remote));
  }

  function remove(id: string) {
    setAttachments((prev) => {
      revoke(prev.filter((attachment) => attachment.id === id));
      return prev.filter((attachment) => attachment.id !== id);
    });
  }

  /** Hands the queue over for sending and empties it. */
  function take(): ReadonlyArray<AttachmentInput> {
    const current = getDraft(key).attachments;
    revoke(current);
    setAttachments(() => []);
    return current.map((attachment) => attachment.input);
  }

  const addDropped = useEffectEvent(async (paths: ReadonlyArray<string>) =>
    add(await fromPaths(paths, remote)),
  );
  useEffect(() => {
    if (!acceptDrops) return;
    return window.desktop?.onFileDrop((paths) => addDropped(paths));
  }, [acceptDrops]);

  return { attachments, add, pick, addFiles, remove, take };
}

export function toTurnOptions(
  prefs: TurnPrefs,
  attachments: ReadonlyArray<AttachmentInput>,
): TurnOptions {
  return {
    effort: prefs.effort,
    fast: prefs.fast,
    permission: prefs.permission,
    attachments,
  };
}
