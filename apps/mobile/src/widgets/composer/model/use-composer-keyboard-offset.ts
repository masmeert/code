import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * How much less than the keyboard's height the composer rises, and the transcript's end with it:
 * the composer's padding keeps the home indicator's room, which the open keyboard covers, so it
 * rises by less, leaving 8 points above the keys.
 */
export function useComposerKeyboardOffset() {
  return useSafeAreaInsets().bottom - 8;
}
