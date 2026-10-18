import { setup, assign, fromPromise } from "xstate";
import type { RelayEvent, RelayGraph } from "./graph-fold";
import { foldEvent, createEmptyGraph, replayEvents } from "./graph-fold";

export interface WaterfallSpan {
  name: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string>;
}

export function buildWaterfall(nodeId: string, events: RelayEvent[]): WaterfallSpan[] {
  const isRun = events.some((event) => "runId" in event && event.runId === nodeId);
  const related = events.filter((event) => {
    if (isRun) return true;
    return "taskId" in event && event.taskId === nodeId;
  });

  return related.map((event, index) => {
    const startTime = event.timestamp;
    const endTime = Math.max(related[index + 1]?.timestamp ?? startTime + 40, startTime + 1);
    const attributes: Record<string, string> = {};
    if ("epoch" in event && event.epoch !== undefined) attributes["relay.epoch"] = String(event.epoch);
    if ("workerId" in event && event.workerId) attributes["relay.worker"] = event.workerId;
    if ("commitSha" in event && event.commitSha) attributes["relay.commit"] = event.commitSha;
    if ("taskId" in event && event.taskId) attributes["relay.task"] = event.taskId;
    return { name: event.type, startTime, endTime, attributes };
  });
}

export type CanvasMode = "live" | "replay";
export type StreamState = "connecting" | "streaming" | "reconnecting" | "error";
export type PlaybackState = "paused" | "playing" | "seeking";
export type LayoutState = "idle" | "measuring" | "computing" | "applied";
export type InteractionState = "idle" | "selecting" | "dragging" | "panning";
export type PanelState = "closed" | "details" | "spans";

export interface CanvasContext {
  mode: CanvasMode;
  graph: RelayGraph;
  events: RelayEvent[];
  eventBuffer: RelayEvent[];
  currentEventIndex: number;
  playbackSpeed: number;
  reconnectAttempts: number;
  selectedNodeId: string | null;
  error: Error | null;
  layoutInProgress: boolean;
  traceData: { spans: WaterfallSpan[] } | null;
}

export const canvasMachine = setup({
  types: {
    context: {} as CanvasContext,
    events: {} as
      | { type: "MODE.SWITCH_TO_LIVE" }
      | { type: "MODE.SWITCH_TO_REPLAY" }
      | { type: "STREAM.CONNECT" }
      | { type: "STREAM.EVENT"; event: RelayEvent }
      | { type: "STREAM.DISCONNECT" }
      | { type: "STREAM.ERROR"; error: Error }
      | { type: "PLAYBACK.PLAY" }
      | { type: "PLAYBACK.PAUSE" }
      | { type: "PLAYBACK.SEEK"; index: number }
      | { type: "PLAYBACK.SET_SPEED"; speed: number }
      | { type: "LAYOUT.START" }
      | { type: "LAYOUT.COMPLETE" }
      | { type: "NODE.CLICK"; nodeId: string }
      | { type: "NODE.DRAG_START" }
      | { type: "NODE.DRAG_END" }
      | { type: "PANE.DRAG_START" }
      | { type: "PANE.DRAG_END" }
      | { type: "PANEL.OPEN_DETAILS" }
      | { type: "PANEL.OPEN_SPANS" }
      | { type: "PANEL.CLOSE" },
  },
  actors: {
    layoutComputer: fromPromise(async ({ input }: { input: { graph: RelayGraph } }) => {
      // Will be computed in Web Worker
      return input.graph;
    }),
    traceLoader: fromPromise(async ({ input }: { input: { nodeId: string; events: RelayEvent[] } }) => {
      return { spans: buildWaterfall(input.nodeId, input.events) };
    }),
  },
}).createMachine({
  id: "canvas",
  type: "parallel",
  context: {
    mode: "live",
    graph: createEmptyGraph(),
    events: [],
    eventBuffer: [],
    currentEventIndex: 0,
    playbackSpeed: 1,
    reconnectAttempts: 0,
    selectedNodeId: null,
    error: null,
    layoutInProgress: false,
    traceData: null,
  },
  states: {
    mode: {
      initial: "live",
      states: {
        live: {
          on: {
            "MODE.SWITCH_TO_REPLAY": {
              target: "replay",
              actions: assign({ mode: "replay" }),
            },
          },
        },
        replay: {
          on: {
            "MODE.SWITCH_TO_LIVE": {
              target: "live",
              actions: assign({
                mode: "live",
                currentEventIndex: ({ context }) => context.events.length - 1,
              }),
            },
          },
        },
      },
    },

    stream: {
      initial: "connecting",
      states: {
        connecting: {
          on: {
            "STREAM.CONNECT": "streaming",
            "STREAM.ERROR": {
              target: "error",
              actions: assign({
                error: ({ event }) => event.error,
              }),
            },
          },
        },
        streaming: {
          on: {
            "STREAM.EVENT": {
              actions: [
                assign({
                  events: ({ context, event }) => [...context.events, event.event],
                }),
                assign({
                  graph: ({ context, event }) => foldEvent(context.graph, event.event),
                  currentEventIndex: ({ context }) => context.events.length,
                }),
              ],
              guard: ({ context }) => context.mode === "live" && !context.layoutInProgress,
            },
            "STREAM.DISCONNECT": "reconnecting",
          },
        },
        reconnecting: {
          after: {
            1000: {
              target: "connecting",
              actions: assign({
                reconnectAttempts: ({ context }) => context.reconnectAttempts + 1,
              }),
            },
          },
          on: {
            "STREAM.CONNECT": {
              target: "streaming",
              actions: assign({ reconnectAttempts: 0 }),
            },
          },
        },
        error: {
          on: {
            "STREAM.CONNECT": "connecting",
          },
        },
      },
    },

    playback: {
      initial: "paused",
      states: {
        paused: {
          on: {
            "PLAYBACK.PLAY": {
              target: "playing",
              guard: ({ context }) => context.mode === "replay",
            },
            "PLAYBACK.SEEK": {
              target: "seeking",
              actions: assign({
                currentEventIndex: ({ event }) => event.index,
              }),
            },
          },
        },
        playing: {
          after: {
            100: [
              {
                target: "paused",
                guard: ({ context }) => context.currentEventIndex >= context.events.length - 1,
              },
              {
                target: "playing",
                actions: assign({
                  currentEventIndex: ({ context }) => Math.min(context.currentEventIndex + 1, context.events.length - 1),
                  graph: ({ context }) => {
                    const nextIndex = Math.min(context.currentEventIndex + 1, context.events.length - 1);
                    return foldEvent(context.graph, context.events[nextIndex]);
                  },
                }),
              },
            ],
          },
          on: {
            "PLAYBACK.PAUSE": "paused",
            "PLAYBACK.SET_SPEED": {
              actions: assign({
                playbackSpeed: ({ event }) => event.speed,
              }),
            },
          },
        },
        seeking: {
          entry: assign({
            graph: ({ context }) => {
              const { graph } = replayEvents(context.events, context.currentEventIndex);
              return graph;
            },
          }),
          always: "paused",
        },
      },
    },

    layout: {
      initial: "idle",
      states: {
        idle: {
          on: {
            "LAYOUT.START": {
              target: "computing",
              actions: assign({ layoutInProgress: true }),
            },
          },
        },
        measuring: {
          always: "computing",
        },
        computing: {
          invoke: {
            src: "layoutComputer",
            input: ({ context }) => ({ graph: context.graph }),
            onDone: {
              target: "applied",
              actions: assign({
                graph: ({ event }) => event.output,
                layoutInProgress: false,
              }),
            },
            onError: {
              target: "idle",
              actions: assign({ layoutInProgress: false }),
            },
          },
        },
        applied: {
          on: {
            "LAYOUT.COMPLETE": "idle",
          },
        },
      },
    },

    interaction: {
      initial: "idle",
      states: {
        idle: {
          on: {
            "NODE.CLICK": {
              target: "selecting",
              actions: assign({
                selectedNodeId: ({ event }) => event.nodeId,
              }),
            },
            "NODE.DRAG_START": "dragging",
            "PANE.DRAG_START": "panning",
          },
        },
        selecting: {
          on: {
            "NODE.CLICK": {
              target: "selecting",
              actions: assign({
                selectedNodeId: ({ event }) => event.nodeId,
              }),
            },
            "NODE.DRAG_START": "dragging",
            "PANE.DRAG_START": "panning",
          },
        },
        dragging: {
          on: {
            "NODE.DRAG_END": "selecting",
          },
        },
        panning: {
          on: {
            "PANE.DRAG_END": "idle",
          },
        },
      },
    },

    panel: {
      initial: "closed",
      states: {
        closed: {
          on: {
            "PANEL.OPEN_DETAILS": "details",
            "PANEL.OPEN_SPANS": "spans",
          },
        },
        details: {
          on: {
            "PANEL.OPEN_SPANS": "spans",
            "PANEL.CLOSE": "closed",
          },
        },
        spans: {
          initial: "loading",
          states: {
            loading: {
              invoke: {
                src: "traceLoader",
                input: ({ context }) => ({
                  nodeId: context.selectedNodeId || "",
                  events: context.events,
                }),
                onDone: {
                  target: "ready",
                  actions: assign({
                    traceData: ({ event }) => event.output,
                  }),
                },
                onError: {
                  target: "error",
                  actions: assign({
                    error: ({ event }) => event.error,
                  }),
                },
              },
            },
            ready: {},
            error: {},
          },
          on: {
            "PANEL.OPEN_DETAILS": "details",
            "PANEL.CLOSE": "closed",
          },
        },
      },
    },
  },
});

export type CanvasMachine = typeof canvasMachine;
