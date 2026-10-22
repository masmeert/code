import * as Schema from "effect/Schema";

/** A Mac app, known by bundle id; the name is what was shown when it was picked. */
export const MacApp = Schema.Struct({
  bundleId: Schema.String,
  name: Schema.String,
});

export type MacApp = typeof MacApp.Type;

/** Keeping this Mac awake, the lid closed included, while agents work or for a set time. */
export const KeepAwakeSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Some thread's turn running keeps the Mac awake. Absent counts as on. */
  whileAgentsWork: Schema.optional(Schema.Boolean),
  /** One stretch of agent work keeps the Mac awake at most this long. */
  maxHours: Schema.optional(Schema.Number),
  /** How long "Keep awake now" lasts; the last one picked. */
  manualMinutes: Schema.optional(Schema.Number),
  /** Ends a session on battery at or below this percentage; 0 turns it off. */
  batteryFloor: Schema.optional(Schema.Number),
  /** Low Power Mode while the lid is closed on battery. Absent counts as on. */
  lowPowerWhenClosed: Schema.optional(Schema.Boolean),
  /** Absent counts as on. */
  muteWhenClosed: Schema.optional(Schema.Boolean),
  /** Paused while the lid is closed. */
  freezeApps: Schema.optional(Schema.Array(MacApp)),
  /** Every other app with a Dock icon is paused too, but protected ones and `keepApps`. */
  freezeOthers: Schema.optional(Schema.Boolean),
  keepApps: Schema.optional(Schema.Array(MacApp)),
});

export type KeepAwakeSettings = typeof KeepAwakeSettings.Type;

export const DEFAULT_KEEP_AWAKE_MAX_HOURS = 8;

export const DEFAULT_KEEP_AWAKE_BATTERY_FLOOR = 10;

export const DEFAULT_KEEP_AWAKE_MANUAL_MINUTES = 120;

/** Why a session keeps the Mac awake: agents working, or a time picked by hand. */
export const KeepAwakeReason = Schema.Literals(["agents", "manual"]);

export type KeepAwakeReason = typeof KeepAwakeReason.Type;

/** Where keeping this Mac awake stands, as its daemon sees it. */
export const KeepAwakeStatus = Schema.Struct({
  /** False off macOS, and on a remote host's daemon. */
  available: Schema.Boolean,
  /** The one-time system setup that lets MassCode keep the Mac awake with the lid closed. */
  access: Schema.Literals(["missing", "installing", "ready"]),
  session: Schema.NullOr(
    Schema.Struct({
      reason: KeepAwakeReason,
      startedAt: Schema.Number,
      endsAt: Schema.Number,
    }),
  ),
  lidClosed: Schema.Boolean,
  frozen: Schema.Array(MacApp),
  /** What went wrong or ended a session, in words for the user; null when there's nothing to say. */
  notice: Schema.NullOr(Schema.String),
});

export type KeepAwakeStatus = typeof KeepAwakeStatus.Type;

/** What closing the lid would do to an app: pause it, leave it, or leave it whatever the settings say. */
export type AppVerdict = "freeze" | "keep" | "protected";

/** An app to pick from: running now, or installed. */
export const AppChoice = Schema.Struct({
  bundleId: Schema.String,
  name: Schema.String,
  /** A PNG data URL; null when the app has none to show. */
  icon: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
});

export type AppChoice = typeof AppChoice.Type;

export const OWN_BUNDLE_ID = "com.apkiosk.masscode";

/** Never paused, even when picked: MassCode itself, and what the desktop can't do without. */
const ALWAYS_RUNNING = new Map([
  [OWN_BUNDLE_ID, "MassCode"],
  ["com.apple.finder", "System"],
  ["com.apple.systempreferences", "System"],
  ["com.apple.ActivityMonitor", "System"],
]);

/** What "freeze every other app" leaves running, by bundle id or bundle id prefix (ending in "."). */
const PROTECTED_APPS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [
    "Terminal",
    [
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "com.mitchellh.ghostty",
      "dev.warp.Warp-Stable",
      "dev.warp.Warp",
      "com.github.wez.wezterm",
      "org.alacritty",
      "net.kovidgoyal.kitty",
      "co.zeit.hyper",
      "com.raphaelamorim.rio",
      "com.termius-dmg.mac",
    ],
  ],
  [
    "Editor",
    [
      "com.microsoft.VSCode",
      "com.microsoft.VSCodeInsiders",
      "com.vscodium",
      "com.todesktop.230313mzl4w4u92",
      "com.exafunction.windsurf",
      "dev.zed.Zed",
      "dev.zed.Zed-Preview",
      "com.apple.dt.Xcode",
      "com.jetbrains.",
      "com.google.android.studio",
      "com.sublimetext.",
      "com.panic.Nova",
      "com.barebones.bbedit",
    ],
  ],
  [
    "AI app",
    [
      "com.anthropic.",
      "com.openai.",
      "com.t3tools.",
      "ai.perplexity.mac",
      "com.electron.ollama",
      "ai.elementlabs.lmstudio",
      "com.google.antigravity",
    ],
  ],
  [
    "Browser",
    [
      "com.apple.Safari",
      "com.apple.SafariTechnologyPreview",
      "com.google.Chrome",
      "org.chromium.Chromium",
      "company.thebrowser.",
      "org.mozilla.firefox",
      "org.mozilla.firefoxdeveloperedition",
      "com.brave.Browser",
      "com.microsoft.edgemac",
      "com.vivaldi.Vivaldi",
      "com.operasoftware.Opera",
      "com.kagi.kagimacOS",
      "app.zen-browser.zen",
    ],
  ],
  [
    "Meeting or recording",
    [
      "us.zoom.xos",
      "com.microsoft.teams",
      "com.microsoft.teams2",
      "com.cisco.webexmeetingsapp",
      "Cisco-Systems.Spark",
      "com.apple.FaceTime",
      "com.electron.wispr-flow",
      "com.granola.app",
      "com.otter.ai",
      "com.obsproject.obs-studio",
      "com.loom.desktop",
      "com.apple.QuickTimePlayerX",
      "com.apple.VoiceMemos",
    ],
  ],
  [
    "Password manager",
    [
      "com.1password.1password",
      "com.agilebits.onepassword7",
      "com.bitwarden.desktop",
      "com.lastpass.LastPass",
      "com.apple.Passwords",
    ],
  ],
  [
    "Network or VM",
    [
      "io.tailscale.ipn.macos",
      "com.tailscale.ipn.macos",
      "com.docker.docker",
      "com.electron.dockerdesktop",
      "dev.kdrag0n.MacVirt",
      "com.utmapp.UTM",
      "com.parallels.desktop.console",
      "com.vmware.fusion",
      "com.wireguard.macos",
      "com.cloudflare.1dot1dot1dot1.macos",
    ],
  ],
  [
    "Database",
    [
      "com.tinyapp.TablePlus",
      "com.postgresapp.Postgres2",
      "com.sequel-ace.sequel-ace",
      "io.beekeeperstudio.desktop",
      "com.redis.RedisInsight-V2",
    ],
  ],
  ["Simulator", ["com.apple.iphonesimulator", "com.google.android.emulator"]],
];

function findProtection(bundleId: string) {
  for (const [label, ids] of PROTECTED_APPS)
    if (ids.some((id) => (id.endsWith(".") ? bundleId.startsWith(id) : bundleId === id)))
      return label;

  return bundleId.startsWith("com.apple.") ? "Apple app" : null;
}

/** What closing the lid does to the app under `settings`, and what protects it when nothing would pause it. */
export function judgeApp(
  bundleId: string,
  settings: KeepAwakeSettings,
): [AppVerdict, string | null] {
  const alwaysRunning = ALWAYS_RUNNING.get(bundleId);

  if (alwaysRunning) return ["protected", alwaysRunning];

  if (settings.keepApps?.some((app) => app.bundleId === bundleId)) return ["keep", null];

  if (settings.freezeApps?.some((app) => app.bundleId === bundleId)) return ["freeze", null];

  const protection = findProtection(bundleId);

  if (protection) return ["protected", protection];

  return [settings.freezeOthers ? "freeze" : "keep", null];
}
