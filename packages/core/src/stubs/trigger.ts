import { Trigger } from "../schema/types.js";

/** Manual trigger stub — logs only in Stage-1. */
export class ManualTrigger implements Trigger {
  readonly id = "manual";
  async fire(reason = "manual"): Promise<void> {
    console.log(`[trigger:manual] fired (${reason})`);
  }
}
