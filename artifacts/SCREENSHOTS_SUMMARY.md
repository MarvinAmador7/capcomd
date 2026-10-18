# Relay Canvas Screenshots

This directory contains screenshots of the Relay Canvas web application running at http://localhost:3001.

## Screenshot Files

### 1. relay-canvas-graph.png (259 KB)
**Description:** Full graph visualization in Replay Mode showing the complete orchestration hierarchy
- Shows Run node at the top (Run run-demo-123)
- Sub-planner planner node connected to run
- Three task nodes (Task task-1, task-2, task-3) in green "MERGED" state
- Lease e1 nodes for each task (blue)
- Worker 1 node at the bottom (blue)
- Verifier nodes (brown/orange) connected to tasks with dashed handoff edges
- Timeline scrubber at bottom showing "Event 33 / 33" and "ALL_TASKS_TERMINAL"
- Minimap visible in bottom-right corner
- Clean view without side panel

### 2. relay-canvas-details.png (346 KB)
**Description:** Graph view with Node Details Panel open for "Task task-1"
- Same graph layout as #1
- Right side panel showing:
  - TYPE: task
  - STATE: MERGED (green badge)
  - CONTEXT: JSON showing handoff details with epoch:3, branch info
  - RECENT EVENTS (5): VERIFIED_AND_MERGED, VERIFY_STARTED, HANDOFF, WORKER_STARTED, LEASE_GRANTED
- Demonstrates the interactive node inspection feature

### 3. relay-canvas-events.png (275 KB)
**Description:** Browser screenshot showing graph with side panel for "Task task-3"
- Shows the full browser chrome and URL bar (localhost:3001)
- Node details panel open for Task task-3
- Similar layout to #2 but captured via browser screenshot tool
- Shows RECENT EVENTS: VERIFIED_AND_MERGED, VERIFY_STARTED, HANDOFF, WORKER_STARTED, LEASE_GRANTED

### 4. relay-canvas-timeline.png (346 KB)
**Description:** Full-page screenshot emphasizing the timeline scrubber
- Same view as relay-canvas-details.png but captured with fullPage: true
- Shows complete vertical layout including timeline controls
- Demonstrates the replay functionality with play/pause controls

### 5. relay-canvas-live.png (342 KB)
**Description:** Live Mode view with Task task-1 details panel
- Top-right indicator shows "● LIVE" instead of "⏯ REPLAY"
- "Live Mode" button active (blue) in top-left
- Same graph structure but in live monitoring mode
- Side panel open showing Task task-1 details
- No timeline scrubber at bottom (only in Replay mode)

### 6. relay-canvas-full-graph.png (29 KB) [OLD - incomplete data]
**Description:** Initial screenshot from broken fixture data - shows blank canvas
- This was captured before fixing the demo-run.ts fixture file
- Kept for historical reference

## Graph Elements Visible

### Node Types & Colors:
- **Run** (brown/orange border): Top-level orchestration run
- **Planner** (dark blue): Sub-planner that creates tasks
- **Tasks** (green border): Three merged tasks showing completed work
- **Leases** (blue): Lease e1 nodes managing worker access
- **Worker** (blue): Single worker node processing tasks
- **Verifiers** (brown/orange): Verification nodes checking task outputs

### Edge Types:
- **Spawn edges** (gray, solid): Run → Planner, Planner → Tasks
- **Lease edges** (blue, solid): Task → Lease, Lease → Worker
- **Handoff edges** (orange, dashed): Task → Verifier

### UI Features:
- Dark theme (#0a0a15 background)
- Mode toggle (Replay/Live Mode)
- Timeline scrubber with play/pause (Replay mode only)
- Minimap for navigation
- Zoom controls (bottom-left)
- Node details panel (appears on node click)
- Run ID input for loading custom runs

## Technical Details

- **Resolution:** 1920x1080 @ 2x device scale (3840x2160 effective)
- **Captured with:** Playwright (chromium) via headless browser
- **App Framework:** React Flow with ELK auto-layout
- **Demo Data:** 33 events from fixture showing complete task lifecycle
- **Date:** October 17, 2026

## Notes

The app successfully demonstrates:
1. ✅ Hierarchical graph visualization with automatic layout
2. ✅ State-based node coloring (merged=green, running=blue, etc.)
3. ✅ Interactive node details with event history
4. ✅ Replay mode with timeline scrubbing
5. ✅ Live mode toggle (ready for WebSocket integration)
6. ✅ Multiple edge types showing relationships
7. ✅ Minimap for large graph navigation

## Issue Fixed

The demo-run.ts fixture file was corrupted/incomplete (only 4 events without entityId fields).
Fixed by restoring original version from git (commit 9468fae) which contains 33 properly structured events.
