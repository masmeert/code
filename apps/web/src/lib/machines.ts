/** Stands for this Mac where a picker's value has to be a string. */
export const THIS_MAC = "\u0000this-mac";

/** This Mac, then each remote host, as picker options; `machine` is null for this Mac. */
export function buildMachineOptions<Host>(hosts: Readonly<Record<string, Host>>) {
  return [null, ...Object.keys(hosts)].map((machine) => ({
    machine,
    value: machine ?? THIS_MAC,
    label: machine ?? "This Mac",
  }));
}

export function toMachine(value: string) {
  return value === THIS_MAC ? null : value;
}
