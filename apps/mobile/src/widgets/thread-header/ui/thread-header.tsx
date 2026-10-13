import type { Project } from "@masscode/contracts";
import { BlurView } from "expo-blur";
import { router, Stack } from "expo-router";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { Text } from "@/shared/ui";

const StyledBlurView = withUniwind(BlurView);

/** The thread's title over its project and computer, left by the back button, in a glass bar the transcript scrolls under. */
export function ThreadHeader({
  title,
  project,
  hostName,
}: {
  title: string;
  project: Project | undefined;
  hostName: string;
}) {
  const heading = (
    <View className="max-w-64">
      <Text numberOfLines={1} className="text-[17px] leading-[22px] font-extrabold">
        {title}
      </Text>
      <Text numberOfLines={1} className="text-[13px] leading-4 text-muted-foreground">
        {project ? `${project.name} · ${hostName}` : hostName}
      </Text>
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          // iOS draws its glass bar over the transcript, which scrolls on underneath.
          headerTransparent: true,
          headerBackground: () => (
            <StyledBlurView
              tint="systemChromeMaterial"
              intensity={100}
              className="flex-1 border-b-[0.5px] border-border-strong"
            />
          ),
          headerTitle: "",
        }}
      />
      {/* Items on the left take the back button's place, so it comes back as the first of them. */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="chevron.left"
          accessibilityLabel="Back"
          // Opened from a link there's nothing behind it; the thread list is the way out.
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        <Stack.Toolbar.View hidesSharedBackground>{heading}</Stack.Toolbar.View>
      </Stack.Toolbar>
    </>
  );
}
