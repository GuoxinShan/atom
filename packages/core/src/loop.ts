import type { Atom, AtomType } from "./types.ts";
import type { TriggerConfig, TriggerPipeline } from "./interfaces.ts";
import { HUMAN_GATED_PIPELINES } from "./interfaces.ts";

export class HumanGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanGateError";
  }
}

/** atom_event / hook-on-atom: filter by type (+ optional subject). */
export function matchesAtomEvent(trigger: TriggerConfig, atom: Atom): boolean {
  if (!trigger.enabled) return false;
  const hookOnAtom = trigger.kind === "hook" && trigger.config["on"] === "atom";
  if (trigger.kind !== "atom_event" && !hookOnAtom) return false;
  const types = atomTypeFilters(trigger);
  if (types.length > 0 && !types.includes(atom.type)) return false;
  const subject = trigger.config["subject_id"];
  if (typeof subject === "string" && subject !== atom.subject_id) return false;
  return true;
}

export function atomTypeFilters(trigger: TriggerConfig): AtomType[] {
  const one = trigger.config["type"];
  const many = trigger.config["types"];
  const out: string[] = [];
  if (typeof one === "string") out.push(one);
  if (Array.isArray(many)) out.push(...many.map((x) => String(x)));
  return out as AtomType[];
}

/**
 * Auto-chain must not skip a human gate (approve / spec tighten / handoff).
 * `candidate_proposed` never auto-accepts.
 */
export function assertAutoChainAllowed(trigger: TriggerConfig, atom: Atom): void {
  if (HUMAN_GATED_PIPELINES.has(trigger.pipeline)) {
    throw new HumanGateError(
      `atom_event ${trigger.id} pipeline=${trigger.pipeline} requires a human gate (atom ${atom.type} ${atom.subject_id})`,
    );
  }
  if (atom.type === "candidate_proposed" && trigger.pipeline !== "digest") {
    throw new HumanGateError(
      `atom_event ${trigger.id} cannot auto-advance past candidate_proposed; wait for decision_accepted`,
    );
  }
}

export function matchingAtomEventTriggers(
  triggers: TriggerConfig[],
  atom: Atom,
): TriggerConfig[] {
  return triggers.filter((t) => matchesAtomEvent(t, atom));
}

function isAuto(trigger: TriggerConfig): boolean {
  return trigger.config["auto"] === true;
}

export type AtomFanout = {
  triggers: TriggerConfig[];
  dispatch?: (trigger: TriggerConfig, atom: Atom) => Promise<void>;
  log?: (msg: string) => void;
};

/** After each append: observe → optional Trigger → Agent. Auto-dispatch is gated. */
export async function fanoutAtom(atom: Atom, fanout: AtomFanout): Promise<void> {
  const log = fanout.log ?? ((m: string) => console.log(m));
  for (const trigger of matchingAtomEventTriggers(fanout.triggers, atom)) {
    log(`[atom:loop] ${atom.type} → trigger ${trigger.id} (${trigger.pipeline})`);
    if (!isAuto(trigger) || !fanout.dispatch) continue;
    try {
      assertAutoChainAllowed(trigger, atom);
    } catch (err) {
      log(`[atom:loop] gate ${err instanceof Error ? err.message : err}`);
      continue;
    }
    await fanout.dispatch(trigger, atom);
  }
}
