import { AttachmentInput } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage.ts";
import type { PromptAttachment } from "@masscode/ui/agents/prompt-input";

export interface DraftAttachment extends PromptAttachment {
  readonly input: AttachmentInput;
}

export interface Draft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
}

const EMPTY: Draft = { text: "", attachments: [] };

/**
 * What's typed in each composer, keyed like the composer's prefs (a thread id, or
 * "draft:new"). Kept outside the component so switching threads keeps each one's
 * unsent text, and so other parts of the window (rewind, quoting, the follow-up queue)
 * can put text into a composer.
 */
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();

export function getDraft(key: string) {
  return drafts.get(key) ?? EMPTY;
}

export function setDraft(key: string, next: Draft | ((prev: Draft) => Draft)) {
  const value = typeof next === "function" ? next(getDraft(key)) : next;
  if (value.text === "" && value.attachments.length === 0) drafts.delete(key);
  else drafts.set(key, value);
  for (const listener of listeners) listener();
}

/** Adds text to a composer as its own paragraph, after what's there. */
export function appendToDraft(key: string, text: string) {
  setDraft(key, (prev) => ({
    ...prev,
    text: prev.text.trim() ? `${prev.text.trimEnd()}\n\n${text}` : text,
  }));
}

export function useDraft(key: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getDraft(key),
  );
}

/** Puts the caret in the window's composer. */
export function focusComposer() {
  requestAnimationFrame(() => {
    // Hidden threads' views stay mounted, composers and all.
    const textarea = [
      ...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-composer]"),
    ].find((candidate) => candidate.checkVisibility());
    if (!textarea) return;

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
}

// ⌘S tucks the current prompt away for later (t3code's prompt stash). Pasted files
// travel as data and would bloat storage, so only text and file paths are kept.

const Stash = Schema.Struct({
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
});
export type Stash = typeof Stash.Type;
const Stashes = Schema.Array(Stash);

const STASH_KEY = "masscode.stash";
const stashListeners = new Set<() => void>();

function readStashes() {
  return readStored(STASH_KEY, Stashes, []);
}

let stashes = readStashes();

function writeStashes(next: ReadonlyArray<Stash>) {
  stashes = next;
  writeStored(STASH_KEY, Stashes, next);
  for (const listener of stashListeners) listener();
}

export function useStashes() {
  return useSyncExternalStore(
    (listener) => {
      stashListeners.add(listener);
      return () => stashListeners.delete(listener);
    },
    () => stashes,
  );
}

/** Moves a composer's draft into the stash; false if there's nothing to keep. */
export function stashDraft(key: string) {
  const draft = getDraft(key);
  const attachments = draft.attachments.filter((attachment) =>
    AttachmentInput.guards.path(attachment.input),
  );
  if (!draft.text.trim() && !attachments.length) return false;

  writeStashes([
    { id: crypto.randomUUID(), text: draft.text, attachments, at: Date.now() },
    ...stashes,
  ]);
  setDraft(key, EMPTY);
  return true;
}

/** Moves a stash back into a composer, after whatever is there. */
export function restoreStash(key: string, id: string) {
  const stash = stashes.find((candidate) => candidate.id === id);
  if (!stash) return;

  writeStashes(stashes.filter((candidate) => candidate.id !== id));
  setDraft(key, (prev) => ({
    text: prev.text.trim() ? `${prev.text.trimEnd()}\n\n${stash.text}` : stash.text,
    attachments: [...prev.attachments, ...stash.attachments],
  }));
  focusComposer();
}

window.addEventListener("storage", (event) => {
  if (event.key !== STASH_KEY) return;
  stashes = readStashes();
  for (const listener of stashListeners) listener();
});
