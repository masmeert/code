import { router, Stack, useLocalSearchParams } from "expo-router";
import { FormChoiceSection, FormList } from "@/components/FormList.tsx";
import { useThreadSettings } from "@/lib/thread-settings.ts";

/** One option's choices, like effort; picking one applies it and goes back. */
export default function ThreadSettingsChoiceScreen() {
  const { title } = useLocalSearchParams<{ title: string }>();

  const group = useThreadSettings((state) =>
    state.session?.options.find((candidate) => candidate.title === title),
  );

  if (!group) return null;

  return (
    <>
      <Stack.Screen options={{ title: group.title }} />
      <FormList>
        <FormChoiceSection
          title={group.title}
          value={group.value}
          options={group.options}
          onChange={(value) => {
            group.onChange(value);
            router.back();
          }}
        />
      </FormList>
    </>
  );
}
