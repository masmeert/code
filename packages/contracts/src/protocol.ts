export const DEFAULT_DAEMON_PORT = 47821;

/**
 * Bumped when clients and daemons stop understanding each other's frames. The daemon turns
 * other versions away (closing with `PROTOCOL_MISMATCH`), and clients check the shell's.
 */
export const PROTOCOL_VERSION = 3;

export const PROTOCOL_MISMATCH = 4426;

/** The close code for a phone whose token the host doesn't know, or no longer does. */
export const UNPAIRED = 4001;
