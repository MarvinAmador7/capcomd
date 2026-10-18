import { Command } from "commander";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, any>;
}

export const traceCommand = new Command("trace")
  .description("Display trace waterfall for a run")
  .argument("<runId>", "Run ID to trace")
  .option("--json", "Output raw JSON")
  .action(async (runId: string, options) => {
    await trace({ runId, json: options.json });
  });

export async function trace(opts: { runId: string; json?: boolean }) {
  const { runId, json } = opts;
  const tracePath = join(".traces", `${runId}.ndjson`);

    if (!existsSync(tracePath)) {
      console.error(`No trace found for run: ${runId}`);
      console.error(`Expected file: ${tracePath}`);
      process.exit(1);
    }

    const content = await readFile(tracePath, "utf-8");
    const spans: Span[] = content
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    if (json) {
      console.log(JSON.stringify(spans, null, 2));
      return;
    }

    // Build span tree
    const minTime = Math.min(...spans.map((s) => s.startTime));
    const maxTime = Math.max(...spans.map((s) => s.endTime || s.startTime));
    const totalDuration = maxTime - minTime;

    console.log(`\nTrace: ${runId}`);
    console.log(`Duration: ${totalDuration}ms\n`);

    function printSpan(span: Span, indent: number = 0) {
      const duration = span.endTime ? span.endTime - span.startTime : 0;
      const offset = span.startTime - minTime;
      const barWidth = 60;
      const startPos = Math.floor((offset / totalDuration) * barWidth);
      const barLength = Math.max(1, Math.floor((duration / totalDuration) * barWidth));

      const prefix = "  ".repeat(indent);
      const bar = " ".repeat(startPos) + "█".repeat(barLength);
      
      console.log(`${prefix}${span.name.padEnd(30)} ${duration.toString().padStart(6)}ms ${bar}`);

      // Print key attributes
      if (span.attributes) {
        const keys = ["relay.state_from", "relay.state_to", "gen_ai.request.model"];
        for (const key of keys) {
          if (span.attributes[key]) {
            console.log(`${prefix}  ${key}: ${span.attributes[key]}`);
          }
        }
      }

      // Find and print children
      const children = spans.filter((s) => s.parentSpanId === span.spanId);
      for (const child of children) {
        printSpan(child, indent + 1);
      }
    }

    const roots = spans.filter((s) => !s.parentSpanId);
    for (const root of roots) {
      printSpan(root);
    }

    console.log();
}
