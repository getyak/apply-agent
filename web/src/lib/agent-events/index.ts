/**
 * Barrel for the agent-events module. Components import from
 * `@/lib/agent-events` rather than reaching into individual files.
 */

export * from "./schema";
export { extractRelayMeta, compareBySeq } from "./relay-meta";
export {
  applyEvent,
  emptyState,
  makeStep,
  upsertStep,
  type ReducerState,
} from "./reducer";
export {
  useAgentStream,
  useStep,
  useStepIds,
  useIsStreaming,
  useStreamError,
  useHasSteps,
  sendAsk,
  sendResume,
  cancelAgentStream,
  type AskSurface,
  type SendAskOptions,
  type DockAttachmentLite,
  type RenderStepKind,
} from "./store";
export {
  consumeAgentStream,
  type ConsumerCallbacks,
  type ConsumeArgs,
} from "./consumer";
