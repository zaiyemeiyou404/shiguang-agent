import type { PluginAdapter } from "./registry.js";
import { PluginRegistry } from "./registry.js";
import { createPluginTools } from "./tool-adapter.js";
import type { Tool } from "../tools/types.js";
import { xdyouPlugin } from "./xdyou-plugin.js";

export function createBundledPlugins(): PluginAdapter[] {
  return [xdyouPlugin];
}

export function createBundledPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of createBundledPlugins()) registry.register(plugin);
  return registry;
}

export function createBundledPluginTools(): Tool[] {
  return createBundledPlugins().flatMap((plugin) => createPluginTools(plugin));
}
