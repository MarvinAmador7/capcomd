import { createStore } from "@xstate/store";

export interface CanvasPreferences {
  theme: "light" | "dark";
  autoLayout: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  miniMapEnabled: boolean;
}

export const preferencesStore = createStore<CanvasPreferences>({
  theme: "dark",
  autoLayout: true,
  showGrid: true,
  snapToGrid: false,
  miniMapEnabled: true,
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
