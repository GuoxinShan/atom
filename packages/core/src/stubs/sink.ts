import type { SubscriptionSink } from "../schema/types.js";
import { dispatchSubscriptions } from "../registry/subscriptions.js";

export class LogSubscriptionSink implements SubscriptionSink {
  readonly id = "log";
  constructor(private readonly repoRoot?: string) {}
  async publish(payload: { kind: string; text: string; meta?: Record<string, unknown> }): Promise<void> {
    if (this.repoRoot) {
      await dispatchSubscriptions(this.repoRoot, payload);
      return;
    }
    console.log(`[sink:log] ${payload.kind}: ${payload.text}`);
  }
}

export class NoopSubscriptionSink implements SubscriptionSink {
  readonly id = "noop";
  async publish(): Promise<void> {}
}

/** @deprecated use LogSubscriptionSink(repoRoot) which fans out via subscriptions.json */
export class WebhookSubscriptionSink implements SubscriptionSink {
  readonly id = "webhook";
  constructor(private readonly repoRoot: string) {}
  async publish(payload: { kind: string; text: string; meta?: Record<string, unknown> }): Promise<void> {
    await dispatchSubscriptions(this.repoRoot, payload);
  }
}
