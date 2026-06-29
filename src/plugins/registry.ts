import type { PluginManifest, PluginCallRequest, PluginCallResult } from "./types.js";

export interface PluginAdapter {
  manifest: PluginManifest;
  execute(request: PluginCallRequest): Promise<PluginCallResult>;
}

export class PluginRegistry {
  private adapters = new Map<string, PluginAdapter>();

  register(adapter: PluginAdapter): void {
    this.adapters.set(adapter.manifest.pluginId, adapter);
  }

  get(pluginId: string): PluginAdapter | undefined {
    return this.adapters.get(pluginId);
  }

  all(): PluginAdapter[] {
    return Array.from(this.adapters.values());
  }

  async call(request: PluginCallRequest): Promise<PluginCallResult> {
    const adapter = this.adapters.get(request.pluginId);
    if (!adapter) {
      return { ok: false, output: null, error: `unknown plugin: ${request.pluginId}`, durationMs: 0 };
    }
    const capability = adapter.manifest.capabilities.find((c) => c.id === request.capability);
    if (!capability) {
      return { ok: false, output: null, error: `unknown capability: ${request.capability}`, durationMs: 0 };
    }
    return adapter.execute(request);
  }
}
