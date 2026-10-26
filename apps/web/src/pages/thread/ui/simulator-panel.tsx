import type { Device, DeviceHub } from "@masscode/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@masmeert/ui/dropdown-menu";
import { ResizeHandle } from "@masmeert/ui/resize-handle";
import { useResizable } from "@masmeert/ui/hooks/use-resizable";
import { cn } from "@masscode/ui/lib/utils";
import {
  IconArrowLeft,
  IconChevronDown,
  IconHome,
  IconLoader2,
  IconPlugConnectedX,
  IconRotateClockwise,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { IconButton } from "@/shared/ui";
import { connectDeviceStream, type DeviceStream } from "../lib/device-stream.ts";
import { attachDevice, listDevices, toggleSimulator, useSimulator } from "@/entities/simulator";
import { useHostStore } from "@/entities/host";
import { ErrorDetails, PanelAction, PanelMessage } from "./panel-message.tsx";
import { closeOnEscape } from "../lib/close-on-escape.ts";
import { typeClass } from "@masmeert/ui/lib/type-scale";

/** How long a device screen may take to show its first frame before the panel offers to reconnect. */
const FIRST_FRAME_TIMEOUT_MS = 15_000;

type Setup =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "installing" }
  | { readonly status: "failed"; readonly message: string; readonly detail: string | null }
  | { readonly status: "ready"; readonly hub: DeviceHub; readonly devices: ReadonlyArray<Device> };

export function SimulatorPanel({ threadId }: { threadId: string }) {
  const { deviceId } = useSimulator(threadId);
  const aside = useRef<HTMLElement>(null);

  const panel = useResizable({
    key: "masscode.simulatorPanelWidth",
    initial: 400,
    side: "start",
    clamp: (width) =>
      Math.max(
        280,
        Math.min(width, (aside.current?.parentElement?.clientWidth ?? window.innerWidth) - 380),
      ),
  });

  const [setup, setSetup] = useState<Setup>({ status: "loading" });
  const [bootingDeviceId, setBootingDeviceId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  /** Lists the devices again; false when that failed. */
  async function refreshDevices(install: boolean) {
    const listed = await listDevices(install);

    if (!listed) {
      setSetup({
        status: "failed",
        message: "MassCode didn't answer when asked for devices. Try again in a moment.",
        detail: null,
      });
    } else if (listed.error) {
      setSetup({
        status: "failed",
        message:
          "Couldn't start the device tools. Check that Xcode or Android Studio is installed, then try again.",
        detail: listed.error,
      });
    } else if (!listed.hub) setSetup({ status: "missing" });
    else setSetup({ status: "ready", hub: listed.hub, devices: listed.devices });

    return Boolean(listed?.hub && !listed.error);
  }

  async function loadDevices(install: boolean) {
    setSetup({ status: install ? "installing" : "loading" });

    // The hub forgets its streams when it restarts, so reattach the thread's device.
    if ((await refreshDevices(install)) && deviceId) await bootDevice(deviceId);
  }

  async function bootDevice(id: string) {
    setBootingDeviceId(id);
    setBootError(null);
    const error = await attachDevice(threadId, id);

    // A booted emulator has a serial to stream by now.
    if (!error) await refreshDevices(false);
    setBootingDeviceId(null);
    setBootError(error);
  }

  // Loads once the daemon answers, and again after it restarts, which also restarts the hub.
  const isConnected = useHostStore((state) => state.connected);
  const loadOnConnect = useEffectEvent(() => void loadDevices(false));
  useEffect(() => {
    if (isConnected) loadOnConnect();
  }, [isConnected]);

  const devices = setup.status === "ready" ? setup.devices : [];
  const device = devices.find((candidate) => candidate.id === deviceId);

  // An agent may attach a device this list hasn't seen started.
  const refreshForDevice = useEffectEvent(() => {
    if (setup.status === "ready" && deviceId && !device?.streamId && !bootingDeviceId)
      void refreshDevices(false);
  });

  useEffect(() => refreshForDevice(), [deviceId]);

  function renderPanelBody() {
    if (setup.status === "loading") {
      return (
        <PanelMessage>
          <IconLoader2 className="size-4 animate-spin" />
          Starting the device hub…
        </PanelMessage>
      );
    }

    if (setup.status === "missing") {
      return (
        <PanelMessage>
          <span>
            Run iOS simulators and Android emulators here, for you and the agent. This installs
            expo-device-hub and agent-device from npm into ~/.masscode/tools.
          </span>
          <PanelAction onClick={() => void loadDevices(true)}>Set up</PanelAction>
        </PanelMessage>
      );
    }

    if (setup.status === "installing") {
      return (
        <PanelMessage>
          <IconLoader2 className="size-4 animate-spin" />
          Installing the device tools. This can take a minute…
        </PanelMessage>
      );
    }

    if (setup.status === "failed") {
      return (
        <PanelMessage>
          <span>{setup.message}</span>
          <PanelAction onClick={() => void loadDevices(false)}>Try again</PanelAction>
          {setup.detail ? <ErrorDetails>{setup.detail}</ErrorDetails> : null}
        </PanelMessage>
      );
    }

    if (bootingDeviceId) {
      return (
        <PanelMessage>
          <IconLoader2 className="size-4 animate-spin" />
          Starting{" "}
          {devices.find((candidate) => candidate.id === bootingDeviceId)?.name ?? "the device"}…
        </PanelMessage>
      );
    }

    if (bootError) {
      return (
        <PanelMessage>
          <span>
            Couldn't start{" "}
            {devices.find((candidate) => candidate.id === deviceId)?.name ?? "the device"}. Try
            again, or choose another device above.
          </span>
          {deviceId ? (
            <PanelAction onClick={() => void bootDevice(deviceId)}>Try again</PanelAction>
          ) : null}
          <ErrorDetails>{bootError}</ErrorDetails>
        </PanelMessage>
      );
    }

    if (device?.streamId) {
      return (
        <DeviceScreen
          key={`${device.id}:${device.streamId}`}
          hub={setup.hub}
          device={device}
          streamId={device.streamId}
        />
      );
    }

    if (deviceId) {
      return (
        <PanelMessage>
          <IconLoader2 className="size-4 animate-spin" />
          Starting the device…
        </PanelMessage>
      );
    }

    if (devices.length === 0) {
      return (
        <PanelMessage>
          This Mac has no iOS simulators or Android emulators. Add a simulator in Xcode → Settings →
          Components, or an emulator in Android Studio's Device Manager, then try again.
          <PanelAction onClick={() => void loadDevices(false)}>Try again</PanelAction>
        </PanelMessage>
      );
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <p className={cn(typeClass("caption"), "px-2 py-1.5 text-muted-foreground")}>
          Choose a device to start
        </p>
        {devices.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => void bootDevice(candidate.id)}
            className={cn(
              typeClass("body"),
              "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left transition-colors outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <span className="truncate">{candidate.name}</span>
            <span className={cn(typeClass("caption"), "ml-auto shrink-0 text-muted-foreground")}>
              {candidate.version}
              {candidate.booted ? " · Running" : ""}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <aside
      ref={aside}
      aria-label="Simulator"
      style={{ width: panel.width }}
      onKeyDown={closeOnEscape(() => toggleSimulator(threadId))}
      className="relative flex min-h-0 max-w-[max(calc(100%_-_380px),50%)] min-w-[min(280px,50%)] shrink flex-col border-l border-border bg-background"
    >
      <ResizeHandle
        side="start"
        label="Resize simulator"
        value={panel.width}
        dragging={panel.dragging}
        {...panel.handleProps}
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={setup.status !== "ready"}
            className={cn(
              typeClass("caption"),
              "flex h-7 min-w-0 items-center gap-1 rounded-lg px-2 text-foreground transition-colors outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
            )}
          >
            <span className="truncate">{device?.name ?? "Choose a device"}</span>
            {device ? <span className="text-muted-foreground">{device.version}</span> : null}
            <IconChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" collisionPadding={8}>
            <DropdownMenuRadioGroup
              value={deviceId ?? ""}
              onValueChange={(id) => void bootDevice(id)}
            >
              {devices.map((candidate) => (
                <DropdownMenuRadioItem key={candidate.id} value={candidate.id} closeOnClick>
                  <span className="truncate">{candidate.name}</span>
                  <span className="ml-auto pl-4 text-muted-foreground">
                    {candidate.version}
                    {candidate.booted ? " · Running" : ""}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton
          label="Detach device; it shuts down after 10 idle minutes if started here"
          className="ml-auto"
          disabled={!deviceId}
          onClick={() => void attachDevice(threadId, null)}
        >
          <IconPlugConnectedX className="size-4" />
        </IconButton>
        <IconButton label="Hide simulator (Esc)" onClick={() => toggleSimulator(threadId)}>
          <IconX className="size-4" />
        </IconButton>
      </div>
      {renderPanelBody()}
    </aside>
  );
}

/** The live screen, with touches, keys and hardware buttons sent back to the device. */
function DeviceScreen({
  hub,
  device,
  streamId,
}: {
  hub: DeviceHub;
  device: Device;
  streamId: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLImageElement>(null);
  const stream = useRef<DeviceStream | null>(null);
  const isTouching = useRef(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);
  const [connection, setConnection] = useState(0);
  const [isSlowToConnect, setIsSlowToConnect] = useState(false);

  useEffect(() => {
    setIsSlowToConnect(false);

    const deviceStream = connectDeviceStream(hub, device.platform, streamId, canvas.current!, {
      onStatus: (status) => setIsStreaming(status === "streaming"),
      onMjpeg: setMjpegUrl,
    });

    stream.current = deviceStream;

    return () => deviceStream.stop();
  }, [hub, device.platform, streamId, connection]);

  useEffect(() => {
    if (isStreaming) return;

    const timer = window.setTimeout(() => setIsSlowToConnect(true), FIRST_FRAME_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [isStreaming, connection]);

  // A multipart image may never fire `load`, so watch for its first frame instead.
  useEffect(() => {
    if (!mjpegUrl) return;

    const poll = setInterval(() => {
      if (!fallback.current?.naturalWidth) return;
      setIsStreaming(true);
      clearInterval(poll);
    }, 250);

    return () => clearInterval(poll);
  }, [mjpegUrl]);

  function sendTouch(type: "begin" | "move" | "end", event: React.PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    stream.current?.touch(
      type,
      Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    );
  }

  const pointerHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      surface.current?.focus();
      isTouching.current = true;
      sendTouch("begin", event);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (isTouching.current) sendTouch("move", event);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      isTouching.current = false;
      sendTouch("end", event);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      isTouching.current = false;
      sendTouch("end", event);
    },
  };

  function sendKey(phase: "down" | "up", event: React.KeyboardEvent) {
    if (event.metaKey) {
      // Apple's Simulator shortcuts: ⌘⇧H for Home, ⌘→ to rotate.
      if (phase !== "down") return;

      if (event.shiftKey && event.code === "KeyH") stream.current?.press("home");
      else if (event.code === "ArrowRight") stream.current?.rotate();
      else return;
      event.preventDefault();

      return;
    }

    // Tab still moves focus out, so the screen never traps the keyboard.
    if (event.key === "Tab") return;
    event.preventDefault();
    stream.current?.sendKey(event.nativeEvent, phase);
  }

  return (
    <div
      ref={surface}
      tabIndex={0}
      aria-label="Device screen. Click to focus, then type to send keys."
      onKeyDown={(event) => sendKey("down", event)}
      onKeyUp={(event) => sendKey("up", event)}
      className="flex min-h-0 flex-1 flex-col items-center gap-3 p-4 outline-none"
    >
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        <canvas
          ref={canvas}
          {...pointerHandlers}
          className={cn(
            "max-h-full max-w-full touch-none rounded-[2rem] select-none",
            mjpegUrl && "hidden",
          )}
        />
        {mjpegUrl ? (
          <img
            ref={fallback}
            src={mjpegUrl}
            alt=""
            draggable={false}
            {...pointerHandlers}
            className="max-h-full max-w-full touch-none rounded-[2rem] select-none"
          />
        ) : null}
        {isStreaming ? null : isSlowToConnect ? (
          <div className="absolute inset-0 flex">
            <PanelMessage>
              <span>
                {device.name}'s screen isn't coming through. Reconnect, or detach the device and
                start it again.
              </span>
              <PanelAction
                onClick={() => {
                  setMjpegUrl(null);
                  setConnection((count) => count + 1);
                }}
              >
                Reconnect
              </PanelAction>
            </PanelMessage>
          </div>
        ) : (
          <div
            className={cn(
              typeClass("body"),
              "absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground",
            )}
          >
            <IconLoader2 className="size-4 animate-spin" />
            Connecting to {device.name}…
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        {device.platform === "android" ? (
          <IconButton label="Back (Esc)" onClick={() => stream.current?.press("back")}>
            <IconArrowLeft className="size-4" />
          </IconButton>
        ) : null}
        <IconButton
          label={device.platform === "ios" ? "Home (⌘⇧H)" : "Home"}
          onClick={() => stream.current?.press("home")}
        >
          <IconHome className="size-4" />
        </IconButton>
        {device.platform === "ios" ? (
          <IconButton label="Rotate (⌘→)" onClick={() => stream.current?.rotate()}>
            <IconRotateClockwise className="size-4" />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}
