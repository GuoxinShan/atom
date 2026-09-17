import type { SubscriptionSink } from "./interfaces.ts";

/** Stage-1 outbound sink: log only. No webhook, no chat post. */
export class LogSubscriptionSink implements SubscriptionSink {
  readonly id = "log";

  async publish(event: { topic: string; payload: unknown }): Promise<void> {
    const preview =
      typeof event.payload === "string"
        ? event.payload
        : JSON.stringify(event.payload);
    console.log(`[atom:sink] ${event.topic} ${preview.slice(0, 240)}`);
  }
}
