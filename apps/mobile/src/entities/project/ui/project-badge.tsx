import { getProjectInitials, getProjectTint } from "@masscode/client";
import type { Project } from "@masscode/contracts";
import { View } from "react-native";
import { cn } from "@/shared/lib/cn";
import { Text } from "@/shared/ui";

/** Two-letter project mark, tinted per project the same as on the desktop. */
export function ProjectBadge({
  project,
}: {
  project: Pick<Project, "id" | "name" | "remote" | "folder">;
}) {
  const tint = getProjectTint(project);

  return (
    <View
      aria-hidden
      className={cn("size-[18px] items-center justify-center rounded-[5px]", tint.background)}
    >
      <Text className={cn("text-[9px] leading-none font-semibold tracking-tight", tint.text)}>
        {getProjectInitials(project.name)}
      </Text>
    </View>
  );
}
