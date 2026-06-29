import type { ShiguangBridge } from "./bridge";

declare global {
  interface Window {
    shiguang: ShiguangBridge;
  }
}
