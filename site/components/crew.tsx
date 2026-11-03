"use client";

// The page's one crew, drawn from one run id, and the goal typed into the Ask stage. The static HTML is rendered
// with DEFAULT_SEED and the README's first goal; after hydration each visit draws a fresh crew (or #run=… to share
// one), and "Draw another" redraws every bot on the page at once.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Size } from "@/lib/vendor/bot-avatar.js";
import { DEFAULT_SEED, crewSuffix, crewSvg, crewTeam, randomRunId, type BotOpts } from "@/lib/crew";

const DEFAULT_GOAL = "Fix the failing tests in src/";
export const README_GOALS = [DEFAULT_GOAL, "Add rate limiting to the API", "Fix the off-by-one in src/pager.ts"] as const;

interface Crew {
  seed: string;
  team: ReturnType<typeof crewTeam>;
  redrawn: number;
  redraw: () => void;
  goal: string;
  setGoal: (g: string) => void;
  hydrated: boolean;
}
const CrewContext = createContext<Crew | null>(null);
const useCrew = () => {
  const c = useContext(CrewContext);
  if (!c) throw new Error("useCrew outside CrewProvider");
  return c;
};

export function CrewProvider({ children }: { children: ReactNode }) {
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [redrawn, setRedrawn] = useState(0);
  const [goal, setGoal] = useState<string>(DEFAULT_GOAL);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    setSeed(params.get("run") || randomRunId());
    const g = params.get("goal");
    if (g) setGoal(g);
    setHydrated(true);
  }, []);
  const redraw = useCallback(() => { setSeed(randomRunId()); setRedrawn((n) => n + 1); }, []);
  const team = useMemo(() => crewTeam(seed), [seed]);
  const value = useMemo(() => ({ seed, team, redrawn, redraw, goal, setGoal, hydrated }), [seed, team, redrawn, redraw, goal, hydrated]);
  return <CrewContext.Provider value={value}>{children}</CrewContext.Provider>;
}

/** One crew member's bot. Decorative: the text beside it names the role. */
export function Bot({ i, size = "full", className, style, pose, mood, join }: { i: number; size?: Size; className?: string; style?: CSSProperties; join?: boolean } & BotOpts) {
  const { seed, team } = useCrew();
  const svg = useMemo(() => crewSvg(seed, team, i, size, { pose, mood }), [seed, team, i, size, pose, mood]);
  return <span className={className} style={style} data-join={join || undefined} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** The hero's four, in the slot where the word "crew" would be. They step in again after a redraw. */
export function HeroCrew() {
  const { redrawn } = useCrew();
  return (
    <span className={`slot__crew${redrawn ? " is-redrawn" : ""}`} key={redrawn} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => <Bot key={i} i={i} pose={i === 0 ? "wave" : undefined} style={{ "--k": i } as CSSProperties} />)}
    </span>
  );
}

export function AgentSuffix({ i }: { i: number }) {
  const { seed } = useCrew();
  return <>{crewSuffix(seed, i)}</>;
}


/** The goal as typed, for pieces that need the text rather than the title. */
export const useGoal = () => useCrew().goal;

/** The goal, as each later stage's panel titles the run. */
export function GoalTitle() {
  const { goal } = useCrew();
  const g = goal.trim() || DEFAULT_GOAL;
  return <>{g.charAt(0).toUpperCase() + g.slice(1)}</>;
}

/** The Ask stage's composer: what's typed here titles the run in the next stages. */
export function GoalComposer() {
  const { goal, setGoal } = useCrew();
  return (
    <textarea
      id="goal"
      rows={2}
      spellCheck={false}
      autoComplete="off"
      maxLength={80}
      aria-label="Goal for the run; it titles the panels in the next stages"
      value={goal}
      onChange={(e) => setGoal(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
    />
  );
}

export function TryGoals() {
  const { goal, setGoal } = useCrew();
  return (
    <div className="try" role="group" aria-label="Examples from the README">
      <span>Goals from the README, or type one:</span>
      {README_GOALS.map((g) => (
        <button key={g} type="button" aria-pressed={goal === g} onClick={() => setGoal(g)}>{g}</button>
      ))}
    </div>
  );
}
