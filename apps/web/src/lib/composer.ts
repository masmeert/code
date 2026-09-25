import type {
  Attachment,
  AttachmentInput,
  Effort,
  PermissionLevel,
  ProviderKind,
  TurnOptions,
} from "@apcode/contracts";
import { useEffect, useReducer, useRef } from "react";
import { type DraftAttachment, getDraft, setDraft, useDraft } from "./drafts.ts";

/** Effort levels each harness accepts, lowest first. */
export const EFFORTS: Record<ProviderKind, ReadonlyArray<Effort>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export const EFFORT_LABEL: Record<Effort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  ask: "Ask first",
  "auto-edit": "Auto-edit",
  "full-access": "Full access",
};

export const PERMISSION_DESCRIPTION: Record<PermissionLevel, string> = {
  ask: "Asks before running commands or editing files",
  "auto-edit": "Edits files freely, asks before riskier commands",
  "full-access": "Runs anything without asking, outside the sandbox too",
};

export interface TurnPrefs {
  /** Null leaves it to the harness. */
  readonly effort: Effort | null;
  readonly permission: PermissionLevel;
}

// --- prefs -----------------------------------------------------------------
// Each thread keeps its own picks while the window is open; the last picks
// (effort per harness) become the defaults for new chats.

const PREFS_KEY = "apcode.composer";
type Defaults = {
  effort: Partial<Record<ProviderKind, Effort | null>>;
  permission: PermissionLevel;
};

const readDefaults = (): Defaults => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Defaults | null;
    if (parsed && typeof parsed === "object")
      return { effort: parsed.effort ?? {}, permission: parsed.permission ?? "ask" };
  } catch {}
  return { effort: {}, permission: "ask" };
};

const writeDefaults = (defaults: Defaults) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(defaults));
  } catch {}
};

const perThread = new Map<string, TurnPrefs>();

/** Drops an effort the harness doesn't take (e.g. "max" after switching a draft to Codex). */
const fit = (prefs: TurnPrefs, provider: ProviderKind): TurnPrefs =>
  prefs.effort && !EFFORTS[provider].includes(prefs.effort) ? { ...prefs, effort: null } : prefs;

/** Effort and permission level for the composer identified by `key` (a thread id, or a draft's path). */
export const useTurnPrefs = (key: string, provider: ProviderKind) => {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const defaults = readDefaults();
  const prefs = fit(
    perThread.get(key) ?? {
      effort: defaults.effort[provider] ?? null,
      permission: defaults.permission,
    },
    provider,
  );

  const update = (patch: Partial<TurnPrefs>) => {
    const next = { ...prefs, ...patch };
    perThread.set(key, next);
    const latest = readDefaults();
    writeDefaults({
      effort: { ...latest.effort, [provider]: next.effort },
      permission: next.permission,
    });
    rerender();
  };
  return [prefs, update] as const;
};

// --- attachments -----------------------------------------------------------

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

export const fromPath = (path: string): DraftAttachment => ({
  id: crypto.randomUUID(),
  name: fileName(path),
  image: IMAGE_NAME.test(path),
  input: { _tag: "path", path },
});

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const fromFile = async (file: File): Promise<DraftAttachment> => {
  const image = file.type.startsWith("image/");
  const name =
    file.name || (image ? `Pasted image.${file.type.split("/")[1] ?? "png"}` : "Pasted file");
  return {
    id: crypto.randomUUID(),
    name,
    image,
    preview: image ? URL.createObjectURL(file) : undefined,
    input: {
      _tag: "data",
      name,
      mediaType: file.type || "application/octet-stream",
      data: await readBase64(file),
    },
  };
};

/** A sent message's files, back in a composer (they're on disk by then). */
export const fromSent = (attachment: Attachment): DraftAttachment => fromPath(attachment.path);

/** Past this, pasted text becomes an attached file instead of flooding the prompt (t3code uses 32 KiB too). */
export const LARGE_PASTE_BYTES = 32 * 1024;

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Pasted text as a file the agent can read. */
export const fromText = (text: string): DraftAttachment => {
  const name = `Pasted text (${Math.max(1, Math.round(text.length / 1024))} KB).txt`;
  return {
    id: crypto.randomUUID(),
    name,
    image: false,
    input: { _tag: "data", name, mediaType: "text/plain", data: toBase64(text) },
  };
};

/** Files queued for the next message of composer `key`: picked, pasted, or dropped onto the window. */
export const useAttachments = ({ key, acceptDrops }: { key: string; acceptDrops: boolean }) => {
  const attachments = useDraft(key).attachments;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setAttachments = (
    update: (prev: ReadonlyArray<DraftAttachment>) => ReadonlyArray<DraftAttachment>,
  ) => setDraft(key, (draft) => ({ ...draft, attachments: update(draft.attachments) }));

  const add = (next: ReadonlyArray<DraftAttachment>) =>
    setAttachments((prev) => [...prev, ...next]);
  const revoke = (list: ReadonlyArray<DraftAttachment>) => {
    for (const a of list) if (a.preview) URL.revokeObjectURL(a.preview);
  };

  const addFiles = async (files: ReadonlyArray<File>) =>
    add(await Promise.all(files.map(fromFile)));

  const pick = async () => {
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
    add((await window.desktop.pickFiles("Attach files")).map(fromPath));
  };

  const remove = (id: string) =>
    setAttachments((prev) => {
      revoke(prev.filter((a) => a.id === id));
      return prev.filter((a) => a.id !== id);
    });

  /** Hands the queue over for sending and empties it. */
  const take = (): ReadonlyArray<AttachmentInput> => {
    const current = getDraft(key).attachments;
    revoke(current);
    setAttachments(() => []);
    return current.map((a) => a.input);
  };

  useEffect(() => {
    if (!acceptDrops) return;
    return window.desktop?.onFileDrop((paths) => add(paths.map(fromPath)));
  }, [acceptDrops, key]);

  return { attachments, add, pick, addFiles, remove, take };
};

export const toTurnOptions = (
  prefs: TurnPrefs,
  attachments: ReadonlyArray<AttachmentInput>,
): TurnOptions => ({
  effort: prefs.effort,
  permission: prefs.permission,
  attachments,
});
