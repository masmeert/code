import { Tabs, TabsList, TabsTrigger } from "@masmeert/ui/tabs";
import { Theme } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import {
  IconColumns2,
  IconDeviceDesktop,
  IconLayoutRows,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import { updateSettings, useSettings } from "@/entities/settings";
import { SettingsGroup, SettingsRow } from "./settings-controls.tsx";

const THEMES: Array<{ value: Theme; label: string; icon: typeof IconSun }> = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
];

export function AppearancePage() {
  const settings = useSettings();

  return (
    <SettingsGroup>
      <SettingsRow label="Theme">
        <Tabs
          value={settings.theme}
          onValueChange={(value) =>
            Schema.is(Theme)(value) && updateSettings({ ...settings, theme: value })
          }
        >
          <TabsList>
            {THEMES.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value}>
                <span className="flex items-center gap-1.5">
                  <Icon className="size-3.5" />
                  {label}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </SettingsRow>
      <SettingsRow label="Diffs">
        <Tabs
          value={settings.diffLayout ?? "unified"}
          onValueChange={(value) =>
            updateSettings({ ...settings, diffLayout: value === "split" ? "split" : "unified" })
          }
        >
          <TabsList>
            <TabsTrigger value="unified">
              <span className="flex items-center gap-1.5">
                <IconLayoutRows className="size-3.5" />
                Stacked
              </span>
            </TabsTrigger>
            <TabsTrigger value="split">
              <span className="flex items-center gap-1.5">
                <IconColumns2 className="size-3.5" />
                Side by side
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </SettingsRow>
    </SettingsGroup>
  );
}
