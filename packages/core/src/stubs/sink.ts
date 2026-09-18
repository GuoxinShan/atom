import fs from "node:fs";
import path from "node:path";
import type { SubscriptionSink } from "../schema/types.js";

export class LogSubscriptionSink implements SubscriptionSink {
  readonly id = "log";
  async publish(payload: { kind: string; text: string; meta?: Record<string, unknown> }): Promise<void> {
    console.log(`[sink:log] ${payload.kind}: ${payload.text}`);
  }
}

export class NoopSubscriptionSink implements SubscriptionSink {
  readonly id = "noop";
  async publish(): Promise<void> {}
}

/** Outbound webhook fan-out from data/subscriptions.json */
export class WebhookSubscriptionSink implements SubscriptionSink {
  readonly id = "webhook";
  constructor(private readonly repoRoot: string) {}

  async publish(payload: { kind: string; text: string; meta?: Record<string, unknown> }): Promise<void> {
    const cfgPath = path.join(this.repoRoot, "data", "subscriptions.json");
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      subscriptions?: Array<{ id: string; url: string; enabled?: boolean; types?: string[] }>;
    };
    const subs = (cfg.subscriptions ?? []).filter((s) => s.enabled !== false);
    for (const s of subs) {
      if (s.types?.length && !s.types.includes(payload.kind)) continue;
      try {
        await fetch(s.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, subscription_id: s.id }),
        });
      } catch (err) {
        console.warn(`[sink:webhook] ${s.id} failed: ${(err as Error).message}`);
      }
    }
  }
}
