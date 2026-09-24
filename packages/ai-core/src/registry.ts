import type { ModelDescriptor, ProviderDescriptor } from "./types.js";

export class ModelRegistry {
  private readonly models = new Map<string, ModelDescriptor>();

  register(model: ModelDescriptor): void {
    if (this.models.has(model.id)) throw new Error(`MODEL_ALREADY_REGISTERED:${model.id}`);
    this.models.set(model.id, model);
  }

  upsert(model: ModelDescriptor): void { this.models.set(model.id, model); }

  get(id: string): ModelDescriptor | undefined { return this.models.get(id); }

  list(): ModelDescriptor[] { return [...this.models.values()]; }

  find(capabilities: string[]): ModelDescriptor[] {
    return this.list().filter(m => m.enabled && capabilities.every(c => m.capabilities.includes(c)));
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>();

  register(provider: ProviderDescriptor): void {
    if (this.providers.has(provider.id)) throw new Error(`PROVIDER_ALREADY_REGISTERED:${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  get(id: string): ProviderDescriptor | undefined { return this.providers.get(id); }

  list(): ProviderDescriptor[] { return [...this.providers.values()]; }
}
