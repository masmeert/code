export {
  closeConnection,
  connect,
  type ConnectionLoss,
  disconnect,
  getHttpOrigin,
  hasConnection,
  isThroughRelay,
  reconnect,
  routeConnectionLossTo,
  routeFramesTo,
  request,
  send,
} from "./daemon.ts";

export { type RelayRoute } from "./relay-socket.ts";
