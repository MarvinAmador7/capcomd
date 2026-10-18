import type { ModelClient } from "./models/fake";
import type { SandboxProvider } from "./providers/sandbox";
import { FakeModelClient } from "./models/fake";
import { FakeProvider } from "./providers/fake";

interface Dependencies {
  model: ModelClient;
  provider: SandboxProvider;
}

let deps: Dependencies | null = null;

export function initDependencies(config?: { model?: ModelClient; provider?: SandboxProvider }) {
  deps = {
    model: config?.model || new FakeModelClient(),
    provider: config?.provider || new FakeProvider(),
  };
}

export function getDependencies(): Dependencies {
  if (!deps) {
    initDependencies();
  }
  return deps!;
}

export function resetDependencies() {
  deps = null;
}
