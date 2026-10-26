import {
  AnimatedToastStack,
  useAnimatedToastStack,
  type ToastInput,
} from "@masscode/ui/motion/animated-toast-stack";
import { useEffect } from "react";

type ToastApi = ReturnType<typeof useAnimatedToastStack>;

/** The mounted `Toaster`'s stack; toasts shown before it mounts are dropped. */
let api: ToastApi | null = null;

/** Shows a toast from anywhere; returns its id for `dismissToast`, or null with no `Toaster`. */
export function showToast(input: ToastInput) {
  return api?.showToast(input) ?? null;
}

export function dismissToast(id: string) {
  api?.dismissToast(id);
}

/**
 * Feedback for an action the user can take back: a toast with an Undo button.
 * `undo` runs at most once.
 */
export function showUndoToast(title: string, undo: () => void, description?: string) {
  return showToast({
    title,
    description,
    status: "neutral",
    duration: 6000,
    action: {
      label: "Undo",
      onClick: (toast) => {
        dismissToast(toast.id);
        undo();
      },
    },
  });
}

export function Toaster() {
  const stack = useAnimatedToastStack({ limit: 4 });

  useEffect(() => {
    api = stack;

    return () => {
      if (api === stack) api = null;
    };
  }, [stack]);

  return (
    <AnimatedToastStack
      toasts={stack.toasts}
      onDismiss={stack.dismissToast}
      position="bottom-left"
      placement="fixed"
    />
  );
}
