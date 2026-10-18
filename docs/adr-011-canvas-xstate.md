# Run canvas: XState architecture (research, 2026-10-17)

## What Stately actually released (sources)
- **@statelyai/graph** (npm created 2026-02-11, v2.6.0 updated 2026-10-12; announced by David Khourshid on X 2026-10-07: https://x.com/DavidKPiano/status/2107796570213126271). Plain-JSON graph IR with hierarchy/ports, immutable ops, diff/patch, algorithms, ELK/dagre/etc. layout adapters as pure functions, and an `xyflow` converter (`toXYFlow`/`fromXYFlow`, parents ordered before children). Docs: https://stately.ai/docs/packages/graph. It has a **React Flow + ELK cookbook** where the graph, not React Flow's node array, is the source of truth (measure, then lay out, then re-render, with the layout in a worker): https://stately.ai/docs/packages/graph/react-flow-elk-pipeline. **This is the tool that best matches what Marvin described.**
- **xstate/graph** (now built into `xstate`; `@xstate/graph` deprecated): `getShortestPaths`, `getSimplePaths`, `createTestModel` for model-based testing. https://stately.ai/docs/graph. xstate@5.30.0 (2026-03-28) added `filterEvents`: https://github.com/statelyai/xstate/releases/tag/xstate@5.30.0. XState v6 is in alpha (6.0.0-alpha.66, Oct 14): https://github.com/statelyai/xstate/releases
- **@xstate/store** v4.3.0 (npm, about Oct 8): event-based store with atoms, `persist`, `undoRedo`, `store.can`, pure `store.transition`, `@xstate/store-react`. https://www.npmjs.com/package/@xstate/store
- **Stately Sketch** (2026-03-26), an open-source visualizer built on @xstate/store: https://stately.ai/blog/2026-03-26-introducing-stately-sketch
- On X, David mentions an unreleased "statelyai/flow" (https://x.com/DavidKPiano/status/2066180942314852627, 2026-06-14) and says he "accidentally built a full React Flow alternative" (https://x.com/DavidKPiano/status/2065545951079493953, 2026-06-12). github.com/statelyai/flow returns 404, so it is not public. Don't plan around it.

## Recommendation
**Data layer (pure, no XState):** `foldEvent(graph, event) => graph` uses @statelyai/graph immutable ops (`getGraphWithNode`/`...UpdatedNode`). Replay at time t is `events.slice(0, i).reduce(foldEvent, empty)`, with a snapshot every N events so scrubbing stays fast. Run `getElkLayout` in a Web Worker, call `toXYFlow`, then render.

**One `canvasMachine` (XState v5) with parallel regions:**
- `mode`: `live` ⇄ `replay` (choosing live leaves replay)
- `stream` (in live mode): `connecting → streaming → reconnecting(backoff) → error`; it buffers events while layout is busy
- `playback` (in replay mode): `paused | playing | seeking` plus a speed setting
- `layout`: `idle → measuring → computing → applied`, re-entered when the graph structure changes (not on status-only changes)
- `interaction`: `idle | selecting | dragging | panning`. The canvas is read-only, so this region stays small
- `panel`: `closed | open.{details | spans}`. Opening the span waterfall invokes a trace loader (`loading → ready | error`)

**What stays in React Flow's store:** viewport, zoom, node measurements, and in-progress drag positions. The machine only receives events like `NODE.CLICK` and `PANE.DRAG_START`, never every frame.

**@xstate/store:** use it for flat UI preferences (filters, collapsed groups, theme), with `persist`. Anything with modes or async work goes in the machine.

**Testing:** `createTestModel(canvasMachine).getShortestPaths()` drives Playwright paths (live to replay to seek to open spans, plus disconnect during replay). Property tests check that folding all events matches the `relay status` output, and that replaying the event log to its end gives the same result as live mode.
