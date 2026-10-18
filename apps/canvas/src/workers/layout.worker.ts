// ELK's own worker runtime. elk-worker.js detects a worker scope and installs
// `self.onmessage`, speaking the protocol elk-api uses. The main thread talks to it
// through elk-api (src/lib/elk-layout.ts), so layout runs off the main thread.
//
// The old version imported elk.bundled *inside* a worker. There, elk-worker sees
// `self`, registers itself as the worker, and never exports FakeWorker, so
// `new ELK()` failed with "_Worker is not a constructor".
import "elkjs/lib/elk-worker.min.js";
export {};
