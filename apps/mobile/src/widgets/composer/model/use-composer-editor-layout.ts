import { type LayoutChangeEvent, useWindowDimensions } from "react-native";
import { useLayoutEffect, useState } from "react";
import {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

/** Centers one line in the row's 36-point slot. */
export const COMPOSER_EDITOR_INSET = 7;

/** From the bottom of the row to the expanded field: the 44-point controls and a gap above them. */
const CONTROLS_CLEARANCE = 52;

/**
 * One line sits in the row between the attach and send controls; once it wraps, the field moves
 * above them at full width and grows to four lines. Only heights animate, so the controls stay put.
 */
export function useComposerEditorLayout(value: string) {
  const { fontScale } = useWindowDimensions();
  const lineHeight = 22 * fontScale;
  const [textHeight, setTextHeight] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const minimum = Math.max(36, Math.ceil(lineHeight) + 2 * COMPOSER_EDITOR_INSET);
  const compactRowHeight = Math.max(44, minimum);

  const height = Math.max(
    minimum,
    Math.min(lineHeight * 4, textHeight) + 2 * COMPOSER_EDITOR_INSET,
  );

  // It stays expanded until cleared: the wider field can fit on one line what wrapped in the slot,
  // and collapsing would wrap it again.
  const shouldExpand = value.length > 0 && (isExpanded || textHeight > lineHeight * 1.5);

  if (shouldExpand !== isExpanded) setIsExpanded(shouldExpand);

  const rowWidth = useSharedValue(0);
  const slotX = useSharedValue(0);
  const slotWidth = useSharedValue(0);
  const editorHeight = useSharedValue(height);
  const rowHeight = useSharedValue(compactRowHeight);
  const expansion = useSharedValue(0);

  useLayoutEffect(() => {
    const timing = { duration: 180, reduceMotion: ReduceMotion.System };
    let secondFrame: number | undefined;

    // Two frames let the text rewrap at its new width first; widths mid-way measure taller.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        editorHeight.value = withTiming(height, timing);
        rowHeight.value = withTiming(
          isExpanded ? height + CONTROLS_CLEARANCE : compactRowHeight,
          timing,
        );
        expansion.value = withTiming(Number(isExpanded), timing);
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);

      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [compactRowHeight, editorHeight, expansion, height, isExpanded, rowHeight]);

  // Heights and offsets follow running animations and measured layout, which classes can't drive.
  const rowStyle = useAnimatedStyle(() => ({ height: rowHeight.value }));

  const editorStyle = useAnimatedStyle(() => ({
    position: "absolute",
    height: editorHeight.value,
    left: isExpanded ? 14 : slotX.value + 4,
    right: isExpanded ? 14 : rowWidth.value - slotX.value - slotWidth.value + 4,
    bottom:
      (compactRowHeight - minimum) / 2 +
      expansion.value * (CONTROLS_CLEARANCE - (compactRowHeight - minimum) / 2),
  }));

  return {
    isExpanded,
    rowStyle,
    editorStyle,
    onRowLayout: (event: LayoutChangeEvent) => {
      rowWidth.value = event.nativeEvent.layout.width;
    },
    onSlotLayout: (event: LayoutChangeEvent) => {
      // Expanded, the slot gives its room to the controls; the return trip needs the compact one.
      if (isExpanded) return;

      slotX.value = event.nativeEvent.layout.x;
      slotWidth.value = event.nativeEvent.layout.width;
    },
    onContentSizeChange: (size: { height: number }) =>
      setTextHeight(size.height - 2 * COMPOSER_EDITOR_INSET),
  };
}
