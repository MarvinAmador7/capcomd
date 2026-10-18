import { createClient } from "rivetkit/client";

const port = Number(process.argv[2] ?? "6420");
const deadline = Date.now() + 45_000;
const client = createClient({ endpoint: `http://127.0.0.1:${port}` });
let last = "actor endpoint not ready";

while (Date.now() < deadline) {
  try {
    await client.run.getOrCreate(["__ready__"]).getRun({ runId: "__ready__" });
    console.log("ready");
    process.exit(0);
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

console.error(last);
process.exit(1);
