import { type SFSymbol, SymbolView, type SymbolWeight } from "expo-symbols";
import { withUniwind } from "uniwind";
import { cn } from "@/shared/lib/cn";

const StyledSymbolView = withUniwind(SymbolView, {
  size: { fromClassName: "className", styleProperty: "width" },
  tintColor: { fromClassName: "className", styleProperty: "color" },
});

/** An SF Symbol, sized and tinted by `className` like text. */
export function Icon({
  name,
  weight,
  className,
}: {
  name: SFSymbol;
  weight?: SymbolWeight;
  className?: string;
}) {
  return (
    <StyledSymbolView
      name={name}
      weight={weight}
      className={cn("size-5 text-foreground", className)}
    />
  );
}
