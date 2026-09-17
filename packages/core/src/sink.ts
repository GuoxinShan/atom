import type { Atom } from "./types.ts";
import type { SubscriptionSink } from "./interfaces.ts";
import type { SubscriptionConfig } from "./subscription.ts";
import { fanoutSubscriptions } from "./subscription.ts";

/** Stage-1 outbound sink: log only. No webhook POST, no chat post. */
export class LogSubscriptionSink implements SubscriptionSink {
  readonly id = "log";

  constructor(private readonly subscriptions: SubscriptionConfig[] = []) {}

  async publish(event: { topic: string; payload: unknown }): Promise<void> {
    const preview =
      typeof event.payload === "string"
        ? event.payload
        : JSON.stringify(event.payload);
    console.log(`[atom:sink] ${event.topic} ${preview.slice(0, 240)}`);
  }

  async onAtom(atom: Atom): Promise<void> {
    await fanoutSubscriptions(atom, this.subscriptions);
  }
}
