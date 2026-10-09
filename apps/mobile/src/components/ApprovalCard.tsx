import { PLAN_APPROVAL_TITLE, type TranscriptItem } from "@masscode/client";
import { type ApprovalDecision, ClientCommand, type UserAnswers } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { cn } from "@/lib/cn.ts";
import { send } from "@/lib/store.ts";
import { Markdown } from "./Markdown.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";

type ApprovalItem = Extract<TranscriptItem, { kind: "approval" }>;

/** What the agent waits on you for: a permission, a plan to build, or questions to answer. */
export function ApprovalCard({
  hostId,
  threadId,
  item,
}: {
  hostId: string;
  threadId: string;
  item: ApprovalItem;
}) {
  const [answers, setAnswers] = useState<Record<string, ReadonlyArray<string>>>({});

  function respond(
    decision: ApprovalDecision,
    extra: { answers?: UserAnswers; permission?: "auto-edit" } = {},
  ) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    send(
      hostId,
      ClientCommand.cases["approval.respond"].make({
        threadId,
        requestId: item.id,
        decision,
        ...extra,
      }),
    );
  }

  if (item.questions) {
    const questions = item.questions;
    const isComplete = questions.every((question) => (answers[question.id]?.length ?? 0) > 0);

    return (
      <View className="gap-4 rounded-2xl bg-muted p-4">
        {questions.map((question) => (
          <View key={question.id} className="gap-2">
            <Text className="text-xs font-medium text-muted-foreground">{question.header}</Text>
            <Text className="font-medium">{question.question}</Text>
            {question.options.map((option) => {
              const chosen = answers[question.id]?.includes(option.label) ?? false;

              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                  accessibilityState={{ checked: chosen }}
                  onPress={() =>
                    setAnswers((current) => {
                      const previous = current[question.id] ?? [];

                      const next = question.multiSelect
                        ? chosen
                          ? previous.filter((label) => label !== option.label)
                          : [...previous, option.label]
                        : [option.label];

                      return { ...current, [question.id]: next };
                    })
                  }
                  className={cn(
                    "rounded-xl border px-3 py-2.5",
                    chosen ? "border-brand/50 bg-brand/10" : "border-border bg-background",
                  )}
                >
                  <Text className="text-sm">{option.label}</Text>
                  {option.description ? (
                    <Text className="text-xs leading-5 text-muted-foreground">
                      {option.description}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
        <View className="flex-row gap-2">
          <Button
            size="sm"
            className="rounded-full"
            disabled={!isComplete}
            onPress={() => respond("allow", { answers })}
          >
            <Text>Send answers</Text>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            onPress={() => respond("deny")}
          >
            <Text>Skip</Text>
          </Button>
        </View>
      </View>
    );
  }

  if (item.title === PLAN_APPROVAL_TITLE)
    return (
      <View className="gap-3 rounded-2xl bg-muted p-4">
        <View className="flex-row items-center justify-between">
          <Text className="font-medium">Plan</Text>
          <View className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5">
            <Text className="text-[11px] text-warning">Awaiting approval</Text>
          </View>
        </View>
        <Markdown text={item.detail} />
        <View className="flex-row gap-2">
          <Button
            size="sm"
            className="rounded-full"
            onPress={() => respond("allow", { permission: "auto-edit" })}
          >
            <Text>Build it</Text>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            onPress={() => respond("deny")}
          >
            <Text>Keep planning</Text>
          </Button>
        </View>
      </View>
    );

  return (
    <View className="overflow-hidden rounded-2xl border border-border-strong bg-muted/20">
      <View className="gap-3 p-3.5">
        <View className="flex-row gap-3">
          <View className="size-9 items-center justify-center rounded-full bg-muted">
            <Icon as={ShieldCheck} className="size-4 text-muted-foreground" />
          </View>
          <View className="flex-1 gap-0.5">
            <Text className="text-[15px] font-medium">
              {item.agent ? `${item.agent} wants to use ${item.title}` : `Allow ${item.title}?`}
            </Text>
            <Text className="font-mono text-xs text-muted-foreground">{item.title}</Text>
          </View>
          <View className="self-start rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5">
            <Text className="text-[11px] text-warning">Approval required</Text>
          </View>
        </View>
        {item.detail ? (
          <Text
            selectable
            numberOfLines={12}
            className="rounded-xl border border-border bg-background/60 p-3 font-mono text-xs leading-5 text-brand"
          >
            {item.detail}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-2 border-t border-border px-3.5 py-3">
        <Button size="sm" className="rounded-full" onPress={() => respond("allow")}>
          <Text>Allow once</Text>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="rounded-full"
          onPress={() => respond("allow-session")}
        >
          <Text>Always allow</Text>
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full" onPress={() => respond("deny")}>
          <Text>Deny</Text>
        </Button>
      </View>
    </View>
  );
}
