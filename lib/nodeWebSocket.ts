import NodeWebSocket from "ws";

/**
 * Railway runs the worker in Node, where a browser-style global WebSocket is
 * not guaranteed. The project already installs `ws` through its Solana stack;
 * expose it only when the runtime has no native implementation.
 */
export function ensureNodeWebSocket(): void {
  if (typeof globalThis.WebSocket === "undefined") {
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket =
      NodeWebSocket as unknown as typeof WebSocket;
  }
}
