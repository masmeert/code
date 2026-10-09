import { Tabs, TabsList, TabsTrigger } from "@masscode/ui/motion/tabs";
import { Theme } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { Monitor, Moon, Sun } from "lucide-react";
import { updateSettings, useStore } from "../../lib/store.ts";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function AppearancePage() {
  const settings = useStore((state) => state.settings);

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
    </SettingsGroup>
  );
}
