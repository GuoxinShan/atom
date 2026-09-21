/**
 * Outbound / pre-post Laya gate.
 *
 * Call this before ATOM (or Desk/CLI) would post a digest, subscription
 * payload, or similar human/group send. High-confidence chat/noise is
 * dropped; high-confidence hold stays with Desk; timeout / outage /
 * ambiguous fail-open to allow. Never auto-sends to Yunzhijia — Desk
 * remains the irreversible-send authority.
 *
 * Seam: `runPipeline` subscription emit (`sink.publish`). Desk/CLI use
 * `evaluateOutboundGate` via `POST /api/outbound-check`.
 */

import { newId } from "../schema/ids.js";
import type { EventStore } from "../store/events.js";
import {
  LayaClient,
  layaOutboundToDetail,
  type LayaOutboundGate,
} from "../agents/laya.js";
import {
  dispatchSubscriptions,
  type SubscriptionPayload,
} from "../registry/subscriptions.js";

export type OutboundCheckInput = {
  title?: string;
  body?: string;
  text?: string;
  kind?: string;
};

export type OutboundCheckResult = {
  gate: LayaOutboundGate;
  layaAvailable: boolean;
  /** True only when a deliver callback actually ran (check API never delivers). */
  delivered: boolean;
  eventId?: string;
  title: string;
  body: string;
  kind: string;
};

/** Auto-emit only on allow, or any fail-open. Drop/hold block the send. */
export function shouldDeliverOutbound(gate: LayaOutboundGate): boolean {
  return gate.failOpen || gate.action === "allow";
}

export function normalizeOutboundInput(input: OutboundCheckInput): {
  title: string;
  body: string;
  kind: string;
} {
  const kind = (input.kind ?? "outbound").trim() || "outbound";
  const body = (input.body ?? input.text ?? "").trim();
  const title = (input.title ?? "").trim() || kind;
  return { title, body, kind };
}

function failOpenAllow(reason: string): LayaOutboundGate {
  return { action: "allow", failOpen: true, reason };
}

function appendOutboundDecision(
  store: EventStore,
  input: {
    title: string;
    body: string;
    kind: string;
    gate: LayaOutboundGate;
    delivered: boolean;
  }
): string {
  const id = newId("agent");
  store.append({
    type: "agent_completed",
    subject_id: id,
    summary: `outbound-check: ${input.gate.action} (${input.gate.reason})`,
    detail: {
      kind: "outbound-check",
      payload_kind: input.kind,
      title: input.title,
      delivered: input.delivered,
      laya_outbound: layaOutboundToDetail(input.gate),
    },
    actor: "system:laya-outbound",
  });
  return id;
}

/**
 * Reusable outbound gate. Same Laya client / timeouts as extract + merge.
 * Optional `store` writes the `laya_outbound` audit on `agent_completed`.
 */
export async function evaluateOutboundGate(
  input: OutboundCheckInput,
  opts?: {
    laya?: LayaClient | false;
    store?: EventStore;
    delivered?: boolean;
    repoRoot?: string;
  }
): Promise<OutboundCheckResult> {
  const { title, body, kind } = normalizeOutboundInput(input);
  const laya =
    opts?.laya === false
      ? null
      : opts?.laya ?? LayaClient.fromEnv({ repoRoot: opts?.repoRoot });

  let gate: LayaOutboundGate;
  let layaAvailable = false;
  if (!laya?.isEnabled()) {
    gate = failOpenAllow("unavailable");
  } else {
    gate = await laya.gateOutbound({ title, body, kind });
    layaAvailable = !laya.unavailable && gate.reason !== "unavailable";
  }

  const delivered = Boolean(opts?.delivered);
  let eventId: string | undefined;
  if (opts?.store) {
    eventId = appendOutboundDecision(opts.store, {
      title,
      body,
      kind,
      gate,
      delivered,
    });
  }

  return { gate, layaAvailable, delivered, eventId, title, body, kind };
}

export type PublishOutboundOpts = {
  laya?: LayaClient | false;
  store?: EventStore;
  repoRoot?: string;
  /** Override fan-out (tests). Default: `dispatchSubscriptions(repoRoot, payload)`. */
  deliver?: (payload: SubscriptionPayload) => Promise<void>;
};

/**
 * Pre-send seam: evaluate, audit, then fan-out only when the gate allows.
 * Drop / hold skip delivery. Fail-open allow still publishes.
 */
export async function publishOutbound(
  repoRoot: string,
  payload: SubscriptionPayload,
  opts?: PublishOutboundOpts
): Promise<OutboundCheckResult> {
  const preview = await evaluateOutboundGate(
    {
      title: payload.kind,
      body: payload.text,
      kind: payload.kind,
    },
    { laya: opts?.laya, repoRoot: opts?.repoRoot ?? repoRoot }
  );

  const deliverNow = shouldDeliverOutbound(preview.gate);
  if (deliverNow) {
    const deliver =
      opts?.deliver ??
      ((p: SubscriptionPayload) => dispatchSubscriptions(repoRoot, p));
    await deliver(payload);
  } else {
    console.log(
      `[outbound] ${preview.gate.action}: skip ${payload.kind} (${preview.gate.reason})`
    );
  }

  let eventId: string | undefined;
  if (opts?.store) {
    eventId = appendOutboundDecision(opts.store, {
      title: preview.title,
      body: preview.body,
      kind: preview.kind,
      gate: preview.gate,
      delivered: deliverNow,
    });
  }

  return { ...preview, delivered: deliverNow, eventId };
}
