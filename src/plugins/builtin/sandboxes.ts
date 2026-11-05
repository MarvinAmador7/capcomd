// The built-in sandbox plugins (docs/spec/plugin-api.md §17.2 step 3), in load order: docker, boxd, then the test
// fakes. Their seams' descriptors, in this order, are the sandbox registry (src/providers/registry.ts DESCRIPTORS).
import { sandboxBoxd } from "./sandbox-boxd";
import { sandboxDocker } from "./sandbox-docker";
import { sandboxFake, sandboxFakeHost } from "./sandbox-fake";

export const SANDBOX_BUILTINS = [sandboxDocker, sandboxBoxd, sandboxFake, sandboxFakeHost] as const;
