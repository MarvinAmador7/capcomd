import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { c } from "../theme";

export interface ViewProps { width: number; height: number; active: boolean }

export const Section = ({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) => (
  <Box flexDirection="column">
    <Text>
      <Text color={c.dim} bold>{title.toUpperCase()}</Text>
      {hint ? <Text color={c.faint}>{"  " + hint}</Text> : null}
    </Text>
    {children}
  </Box>
);

export const Empty = ({ children }: { children: string }) => <Text color={c.dim}>{children}</Text>;

/** Keep the selected index inside a window of `rows` lines. */
export function windowed<T>(items: T[], sel: number, rows: number): { start: number; slice: T[] } {
  const n = Math.max(1, rows);
  const start = Math.max(0, Math.min(sel - Math.floor(n / 2), items.length - n));
  return { start, slice: items.slice(start, start + n) };
}

export function compact(data: Record<string, unknown>, max = 80): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  const out = parts.join("  ");
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

/** Event data without the id already shown in the entity column. */
export function dropEntity(e: { entity: string; data: Record<string, unknown> }): Record<string, unknown> {
  const { taskId, ...rest } = e.data;
  return taskId === e.entity ? rest : e.data;
}
