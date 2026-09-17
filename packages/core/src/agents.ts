import type { Actor, Atom } from "./types.ts";
import type { AtomStore } from "./store.ts";
import type { TriggerPipeline } from "./interfaces.ts";
import { writeAtom } from "./writer.ts";
import { newId } from "./ids.ts";

export type AgentLifecycleDetail = {
  agent_id: string;
  pipeline: TriggerPipeline | string;
  error?: string;
  trigger_id?: string;
};

export function writeAgentStarted(
  store: AtomStore,
  detail: AgentLifecycleDetail,
  actor: Actor = "system",
): Atom {
  return writeAtom(store, {
    type: "agent_started",
    subject_id: newId(),
    summary: `agent ${detail.agent_id} started ${detail.pipeline}`,
    actor,
    refs: [],
    detail,
  });
}

export function writeAgentCompleted(
  store: AtomStore,
  subjectId: string,
  detail: AgentLifecycleDetail,
  actor: Actor = "system",
): Atom {
  return writeAtom(store, {
    type: "agent_completed",
    subject_id: subjectId,
    summary: `agent ${detail.agent_id} completed ${detail.pipeline}`,
    actor,
    refs: [],
    detail,
  });
}

export function writeAgentFailed(
  store: AtomStore,
  subjectId: string,
  detail: AgentLifecycleDetail,
  actor: Actor = "system",
): Atom {
  return writeAtom(store, {
    type: "agent_failed",
    subject_id: subjectId,
    summary: `agent ${detail.agent_id} failed ${detail.pipeline}`,
    actor,
    refs: [],
    detail: { ...detail, error: detail.error ?? "unknown" },
  });
}
