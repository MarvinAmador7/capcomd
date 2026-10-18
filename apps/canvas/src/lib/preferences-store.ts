import { createStore } from "@xstate/store";

export interface CanvasPreferences {
  theme: "light" | "dark";
  autoLayout: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  miniMapEnabled: boolean;
}

// @xstate/store v4 takes { context, on }; the old positional form threw at import
// and left the canvas blank.
export const preferencesStore = createStore({
  context: {
    theme: "dark",
    autoLayout: true,
    showGrid: true,
    snapToGrid: false,
    miniMapEnabled: true,
  } as CanvasPreferences,
  on: {
    SET_PREFERENCES: (context, event: { preferences: Partial<CanvasPreferences> }) => ({
      ...context,
      ...event.preferences,
    }),
  },
});

// Persist to localStorage
if (typeof window !== "undefined") {
  const saved = localStorage.getItem("canvas-preferences");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      preferencesStore.send({ type: "SET_PREFERENCES", preferences: parsed });
    } catch (e) {
      console.error("Failed to load preferences:", e);
    }
  }

  preferencesStore.subscribe((state) => {
    localStorage.setItem("canvas-preferences", JSON.stringify(state.context));
  });
}

export type PreferencesStore = typeof preferencesStore;
