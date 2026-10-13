import { create } from "zustand";

/** One single-choice list the thread settings sheet shows, like effort or permissions. */
export interface ChoiceGroup<Value extends string = string> {
  readonly title: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{ value: Value; label: string }>;
  readonly onChange: (value: Value) => void;
}

/** What the thread settings sheet edits, for the composer that opened it. */
export interface ThreadSettingsSession {
  /** The composer that opened the sheet, which alone keeps the session current. */
  readonly ownerKey: string;
  readonly hostId: string;
  /** The model in use, as "provider:model". */
  readonly model: string | null;
  /** Null while the model can't change, like during a turn. */
  readonly onModelChange: ((model: string) => void) | null;
  readonly options: ReadonlyArray<ChoiceGroup>;
}

/** The open sheet's session; the composer that opened it keeps it current while it's open. */
export const useThreadSettings = create<{ session: ThreadSettingsSession | null }>(() => ({
  session: null,
}));
