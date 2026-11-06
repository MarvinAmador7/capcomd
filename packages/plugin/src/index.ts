// @capcomd/plugin: the capcomd plugin API. Normative spec: docs/spec/plugin-api.md.
export * from "./manifest";
export * from "./shapes";
export * from "./errors";
export * from "./hooks";
export * from "./context";
export * from "./seams";
export * from "./protocol";
export { connect, type ConnectOptions } from "./client";
export * from "./events";
export { EVENT_NAME_PATTERN, EVENT_TYPE_DOC, EVENT_TYPE_PATTERN, eventTypeOwner, isEventType, pluginEventType } from "./event-type";
export * from "./load";
export * from "./semver";
export * from "./testkit";
export * from "./conformance";
export * from "./agent-conformance";
