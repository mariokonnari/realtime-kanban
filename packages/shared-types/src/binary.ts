// JSON can't carry a raw Uint8Array, and this project sends everything
// as JSON text frames (not binary WS frames) for simplicity — the
// tradeoff being ~33% size overhead on CRDT updates, acceptable for
// a portfolio-scale project. Base64 is the bridge.
//
// btoa/atob are used because they're available as globals in both the
// browser and Node 18+, so this file works unmodified on both sides
// of the wire without a bundler-specific polyfill.

export function encodeUpdate(update: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < update.length; i++) {
    binary += String.fromCharCode(update[i]);
  }
  return btoa(binary);
}

export function decodeUpdate(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
