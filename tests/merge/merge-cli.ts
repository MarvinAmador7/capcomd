// Subprocess entry for crash tests: CAPCOMD_KILLPOINT is read at import, so crashes need a process.
import { mergeTask } from "../../src/merge/service";
import { produceFakeWork } from "../../src/merge/fakework";
import { loadMergeConfig } from "../../src/merge/config";
const req = JSON.parse(process.argv[2]!);
const cfg = loadMergeConfig()!;
if (req.produce) await produceFakeWork(cfg, { ...req, epoch: 1 });
console.log(JSON.stringify(await mergeTask(req, cfg)));
process.exit(0);
