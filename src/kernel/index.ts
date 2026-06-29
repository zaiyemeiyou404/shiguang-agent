import type { Repositories } from "../state/repositories.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { EventSink } from "../runtime/event-sink.js";
import { RuntimeCoordinator, type RunStore } from "../runtime/coordinator.js";
import type { Run } from "../core/types.js";

export interface KernelOptions {
  repositories: Repositories;
  pluginRegistry: PluginRegistry;
  eventSink: EventSink;
  defaultModel: string;
}

export class Kernel {
  public readonly runtime: RuntimeCoordinator;
  public readonly plugins: PluginRegistry;
  public readonly repositories: Repositories;
  public readonly defaultModel: string;

  constructor(opts: KernelOptions) {
    this.plugins = opts.pluginRegistry;
    this.repositories = opts.repositories;
    this.defaultModel = opts.defaultModel;

    const store: RunStore = {
      getRun: (id) => this.repositories.runs.get(id),
      updateRun: (id, patch) => this.repositories.runs.update(id, patch),
    };

    this.runtime = new RuntimeCoordinator(store, opts.eventSink);
  }
}

export { RuntimeCoordinator, type RunStore };
