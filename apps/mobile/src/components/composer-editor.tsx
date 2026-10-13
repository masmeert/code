import { requireNativeView } from "expo";
import { useEffect, useMemo, useRef, useState } from "react";
import { type NativeSyntheticEvent, useWindowDimensions, type ViewProps } from "react-native";
import { useResolveClassNames, withUniwind } from "uniwind";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  type ComposerNativeEventSnapshot,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
} from "@/lib/composer-editor-revision.ts";
import { collectComposerInlineTokens } from "@/lib/composer-mentions.ts";

export interface ComposerEditorSelection {
  readonly start: number;
  readonly end: number;
}

/** Text too large to paste inline: the draft as it stands, and where the paste would go. */
export interface ComposerTextPaste {
  readonly value: string;
  readonly text: string;
  readonly selection: ComposerEditorSelection;
}

/** Pastes at least this big become a file, so the agent can read them selectively. */
const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;

type NativeEditorEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

interface NativeComposerEditorProps extends ViewProps {
  readonly controlledDocumentJson: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly readOnly: boolean;
  readonly submitTitle: string;
  readonly alternateSubmitTitle: string;
  readonly scrollEnabled: boolean;
  readonly textPasteThresholdBytes: number;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerSelectionChange: (event: NativeEditorEvent) => void;
  readonly onComposerPasteImages: (
    event: NativeSyntheticEvent<{ readonly uris: ReadonlyArray<string> }>,
  ) => void;
  readonly onComposerPasteText: (
    event: NativeSyntheticEvent<{
      readonly value: string;
      readonly eventCount: number;
      readonly text: string;
      readonly selection: ComposerEditorSelection;
    }>,
  ) => void;
  readonly onComposerContentSizeChange: (
    event: NativeSyntheticEvent<{ readonly width: number; readonly height: number }>,
  ) => void;
  readonly onComposerFocus: () => void;
  readonly onComposerBlur: () => void;
  readonly onComposerSubmit: (event: NativeSyntheticEvent<{ readonly alternate: boolean }>) => void;
}

const NativeView = withUniwind(requireNativeView<NativeComposerEditorProps>("ComposerEditor"));

function basename(path: string) {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** The color a class resolves to, as the hex the native editor parses. */
function useClassColor(className: string) {
  return String(useResolveClassNames(className).color);
}

/**
 * A UIKit text view that draws `@file` mentions and `$skill`s as chips while the draft stays plain
 * text. The draft and caret are controlled; revisions keep a render that lags the native editor
 * from moving its text or caret back mid-typing.
 */
export function ComposerEditor({
  value,
  selection,
  placeholder,
  readOnly,
  scrollEnabled,
  contentInsetVertical,
  submitTitle,
  alternateSubmitTitle,
  className,
  onChangeText,
  onSelectionChange,
  onPasteImages,
  onPasteText,
  onFocus,
  onBlur,
  onSubmit,
}: {
  value: string;
  selection: ComposerEditorSelection;
  placeholder: string;
  /** Blocks edits but keeps focus, the caret and the keyboard. */
  readOnly: boolean;
  scrollEnabled: boolean;
  contentInsetVertical: number;
  /** What Return does, for the hardware keyboard's shortcut list. */
  submitTitle: string;
  /** What Command-Return does. */
  alternateSubmitTitle: string;
  /** Bounds the height with `min-h-*` and `max-h-*`; within them it fits the text. */
  className: string;
  onChangeText: (value: string) => void;
  onSelectionChange: (selection: ComposerEditorSelection) => void;
  onPasteImages: (uris: ReadonlyArray<string>) => void;
  onPasteText: (paste: ComposerTextPaste) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** A hardware keyboard's Return; `alternate` for Command-Return. */
  onSubmit: (alternate: boolean) => void;
}) {
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // The native editor mounts empty, so the snapshot history starts empty: the
  // first controlled payload must be a non-echo so a restored draft (or a
  // recycled native view) is applied rather than skipped.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);
  const confirmedTokensRef = useRef(collectComposerInlineTokens(value));
  const { fontScale } = useWindowDimensions();
  const [contentHeight, setContentHeight] = useState<number>();

  const themeJson = JSON.stringify({
    text: useClassColor("text-foreground"),
    placeholder: useClassColor("text-muted-foreground/55"),
    caret: useClassColor("text-brand"),
    chipBackground: useClassColor("text-muted"),
    chipBorder: useClassColor("text-border-strong"),
    skillBackground: useClassColor("text-brand/12"),
    skillBorder: useClassColor("text-brand/35"),
    skillText: useClassColor("text-brand"),
    fileTint: useClassColor("text-muted-foreground"),
  });

  const tokensJson = useMemo(() => {
    const tokens = collectComposerInlineTokens(value, confirmedTokensRef.current);
    confirmedTokensRef.current = tokens;

    return JSON.stringify(
      tokens.map((token) => ({
        type: token.type,
        source: token.source,
        start: token.start,
        end: token.end,
        label: token.type === "skill" ? token.value : basename(token.value),
      })),
    );
  }, [value]);

  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  const controlledEventCount = resolveComposerControlledEventCount(
    value,
    selection,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );

  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    value,
    selection,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );

  const isNativeEcho =
    controlledEventCount === mostRecentEventCount && acknowledgesLatestNativeEvent;

  const controlledDocumentJson = JSON.stringify({
    value,
    selection: isNativeEcho ? null : selection,
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });

  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;

    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);

  useEffect(() => {
    // A native event that arrived after this render was committed moves the
    // acknowledged revision forward; the editor rejects this payload, so the
    // snapshot history must not assume it applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;

    nativeEventSnapshotsRef.current = assumeComposerControlledState(
      nativeEventSnapshotsRef.current,
      controlledEventCount,
      value,
    );
  }, [value, controlledEventCount, isNativeEcho, controlledDocumentJson]);

  /** Records a native event; false when an older one arrives after a newer one. */
  function acceptNativeEvent(
    eventCount: number,
    nextValue: string,
    nextSelection: ComposerEditorSelection,
  ) {
    const acknowledgedEventCount = acknowledgeComposerNativeEvent(
      mostRecentEventCountRef.current,
      eventCount,
    );

    if (acknowledgedEventCount === null) return false;

    mostRecentEventCountRef.current = acknowledgedEventCount;
    nativeEventSnapshotsRef.current.push({
      eventCount: acknowledgedEventCount,
      value: nextValue,
      selection: nextSelection,
    });
    setMostRecentEventCount(acknowledgedEventCount);
    forceNativeEventRender((sequence) => sequence + 1);

    return true;
  }

  return (
    <NativeView
      controlledDocumentJson={controlledDocumentJson}
      themeJson={themeJson}
      placeholder={placeholder}
      fontSize={16 * fontScale}
      lineHeight={22 * fontScale}
      contentInsetVertical={contentInsetVertical}
      readOnly={readOnly}
      submitTitle={submitTitle}
      alternateSubmitTitle={alternateSubmitTitle}
      scrollEnabled={scrollEnabled}
      textPasteThresholdBytes={PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES}
      className={className}
      // The text's height, measured natively; `className`'s bounds clamp it.
      style={{ height: contentHeight }}
      onComposerChange={({ nativeEvent }) => {
        if (!acceptNativeEvent(nativeEvent.eventCount, nativeEvent.value, nativeEvent.selection))
          return;

        onChangeText(nativeEvent.value);
        onSelectionChange(nativeEvent.selection);
      }}
      onComposerSelectionChange={({ nativeEvent }) => {
        if (!acceptNativeEvent(nativeEvent.eventCount, nativeEvent.value, nativeEvent.selection))
          return;

        // A selection change that raced a text mutation can carry post-edit
        // text. It must reach the parent alongside the acknowledged revision,
        // or the next render stamps the stale draft at that revision and can
        // re-apply it over the newer native text.
        if (nativeEvent.value !== value) onChangeText(nativeEvent.value);
        onSelectionChange(nativeEvent.selection);
      }}
      onComposerPasteImages={({ nativeEvent }) => onPasteImages(nativeEvent.uris)}
      onComposerPasteText={({ nativeEvent }) => {
        if (!acceptNativeEvent(nativeEvent.eventCount, nativeEvent.value, nativeEvent.selection))
          return;

        // Synchronize the draft before an async paste captures its insertion target.
        // React props can still precede the last native keystroke.
        onChangeText(nativeEvent.value);
        onSelectionChange(nativeEvent.selection);
        onPasteText(nativeEvent);
      }}
      onComposerContentSizeChange={({ nativeEvent }) => setContentHeight(nativeEvent.height)}
      onComposerFocus={onFocus}
      onComposerBlur={onBlur}
      onComposerSubmit={({ nativeEvent }) => onSubmit(nativeEvent.alternate)}
    />
  );
}
