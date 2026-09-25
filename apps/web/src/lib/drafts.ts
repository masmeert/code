import { AttachmentInput } from "@apcode/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import type { PromptAttachment } from "@apcode/ui/agents/prompt-input";

/**
 * What's typed in each composer, keyed like the composer's prefs (a thread id, or
 * "draft:new"). Kept outside the component so switching threads keeps each one's
 * unsent text, and so other parts of the window (rewind, quoting, the follow-up queue)
 * can put text into a composer.
 */
export interface DraftAttachment extends PromptAttachment {
  readonly input: AttachmentInput;
}

export interface Draft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
}

const EMPTY: Draft = { text: "", attachments: [] };
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();

export const getDraft = (key: string) => drafts.get(key) ?? EMPTY;

export const setDraft = (key: string, next: Draft | ((prev: Draft) => Draft)) => {
  const value = typeof next === "function" ? next(getDraft(key)) : next;
  if (value.text === "" && value.attachments.length === 0) drafts.delete(key);
  else drafts.set(key, value);
  for (const listener of listeners) listener();
};

/** Adds text to a composer as its own paragraph, after what's there. */
export const appendToDraft = (key: string, text: string) =>
  setDraft(key, (prev) => ({
    ...prev,
    text: prev.text.trim() ? `${prev.text.trimEnd()}\n\n${text}` : text,
  }));

export const useDraft = (key: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getDraft(key),
  );

/** Puts the caret in the window's composer. */
export const focusComposer = () =>
  requestAnimationFrame(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });

// --- stash -----------------------------------------------------------------------
// ⌘S tucks the current prompt away for later (t3code's prompt stash). Pasted files
// travel as data and would bloat storage, so only text and file paths are kept.

export interface Stash {
  readonly id: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
  readonly at: number;
}

const STASH_KEY = "apcode.stash";
const decodeStashes = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String,
        attachments: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            preview: Schema.optionalKey(Schema.String),
            image: Schema.optionalKey(Schema.Boolean),
            input: AttachmentInput,
          }),
        ),
        at: Schema.Number,
      }),
    ),
  ),
);
const stashListeners = new Set<() => void>();
let stashes: ReadonlyArray<Stash> = (() => {
  try {
    return decodeStashes(localStorage.getItem(STASH_KEY) ?? "[]");
  } catch {
    return [];
  }
})();

const writeStashes = (next: ReadonlyArray<Stash>) => {
  stashes = next;
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify(next));
  } catch {}
  for (const listener of stashListeners) listener();
};

export const useStashes = () =>
  useSyncExternalStore(
    (listener) => {
      stashListeners.add(listener);
      return () => stashListeners.delete(listener);
    },
    () => stashes,
  );

/** Moves a composer's draft into the stash; false if there's nothing to keep. */
export const stashDraft = (key: string) => {
  const draft = getDraft(key);
  const attachments = draft.attachments.filter((a) => AttachmentInput.guards.path(a.input));
  if (!draft.text.trim() && !attachments.length) return false;
  writeStashes([
    { id: crypto.randomUUID(), text: draft.text, attachments, at: Date.now() },
    ...stashes,
  ]);
  setDraft(key, EMPTY);
  return true;
};

/** Moves a stash back into a composer, after whatever is there. */
export const restoreStash = (key: string, id: string) => {
  const stash = stashes.find((s) => s.id === id);
  if (!stash) return;
  writeStashes(stashes.filter((s) => s.id !== id));
  setDraft(key, (prev) => ({
    text: prev.text.trim() ? `${prev.text.trimEnd()}\n\n${stash.text}` : stash.text,
    attachments: [...prev.attachments, ...stash.attachments],
  }));
  focusComposer();
};

export const dropStash = (id: string) => writeStashes(stashes.filter((s) => s.id !== id));

window.addEventListener("storage", (e) => {
  if (e.key !== STASH_KEY) return;
  try {
    stashes = decodeStashes(e.newValue ?? "[]");
  } catch {
    stashes = [];
  }
  for (const listener of stashListeners) listener();
});
