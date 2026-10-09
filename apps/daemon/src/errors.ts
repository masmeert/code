export function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
