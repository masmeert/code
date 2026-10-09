import { PLAN_APPROVAL_TITLE, type TranscriptItem } from "@masscode/client";
import { type ApprovalDecision, ClientCommand, type UserAnswers } from "@masscode/contracts";
import * as Haptics from "expo-haptics";
import { Button } from "heroui-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { send } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";

type ApprovalItem = Extract<TranscriptItem, { kind: "approval" }>;

/** What the agent waits on you for: a permission, a plan to build, or questions to answer. */
export function ApprovalCard({
  macId,
  threadId,
  item,
}: {
  macId: string;
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
      macId,
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
      <View className="bg-surface gap-4 rounded-2xl p-4">
        {questions.map((question) => (
          <View key={question.id} className="gap-2">
            <Text className="text-[13px] font-medium tracking-wide text-muted uppercase">
              {question.header}
            </Text>
            <Text className="text-[16px] text-foreground">{question.question}</Text>
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
                  className={
                    chosen
                      ? "rounded-xl border border-accent bg-accent/10 px-3 py-2.5"
                      : "border-separator rounded-xl border px-3 py-2.5"
                  }
                >
                  <Text className="text-[15px] text-foreground">{option.label}</Text>
                  {option.description ? (
                    <Text className="text-[13px] text-muted">{option.description}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
        <View className="flex-row gap-2">
          <Button isDisabled={!isComplete} onPress={() => respond("allow", { answers })}>
            Send answers
          </Button>
          <Button variant="secondary" onPress={() => respond("deny")}>
            Skip
          </Button>
        </View>
      </View>
    );
  }

  if (item.title === PLAN_APPROVAL_TITLE)
    return (
      <View className="bg-surface gap-3 rounded-2xl p-4">
        <Text className="text-[13px] font-medium tracking-wide text-muted uppercase">Plan</Text>
        <Markdown text={item.detail} />
        <View className="flex-row gap-2">
          <Button onPress={() => respond("allow", { permission: "auto-edit" })}>Build it</Button>
          <Button variant="secondary" onPress={() => respond("deny")}>
            Keep planning
          </Button>
        </View>
      </View>
    );

  return (
    <View className="bg-surface gap-3 rounded-2xl p-4">
      <Text className="text-[15px] font-medium text-foreground">
        {item.agent ? `${item.agent} wants to use ${item.title}` : `Allow ${item.title}?`}
      </Text>
      {item.detail ? (
        <Text
          numberOfLines={12}
          className="bg-surface-secondary rounded-xl p-3 font-mono text-[13px] leading-5 text-foreground"
        >
          {item.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button onPress={() => respond("allow")}>Allow</Button>
        <Button variant="secondary" onPress={() => respond("allow-session")}>
          Always this thread
        </Button>
        <Button variant="danger-soft" onPress={() => respond("deny")}>
          Deny
        </Button>
      </View>
    </View>
  );
}
