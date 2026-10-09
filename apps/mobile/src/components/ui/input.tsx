import { TextInput } from "react-native";
import { cn } from "@/lib/cn.ts";

/** The desktop's field: rounded, hairline border, brand edge while focused. */
function Input({
  className,
  ...props
}: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) {
  return (
    <TextInput
      className={cn(
        "h-11 w-full rounded-xl border border-input bg-background px-3.5 font-sans text-[15px] text-foreground focus:border-brand/40 dark:bg-input/30",
        props.editable === false && "opacity-50",
        className,
      )}
      placeholderTextColorClassName="accent-muted-foreground/55"
      selectionColorClassName="accent-brand"
      cursorColorClassName="accent-brand"
      {...props}
    />
  );
}

export { Input };
