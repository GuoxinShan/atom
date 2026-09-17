import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Atom, AtomType } from "./types.ts";
import { ATOM_TYPES } from "./types.ts";

export const SubscriptionConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(false),
  /** Outbound HTTP URL. Stage-1 never POSTs; logs a stub line instead. */
  url: z.string().min(1),
  /** HMAC secret (keep empty in git). Prefer a secret store later. */
  secret: z.string().optional().default(""),
  /** Empty / omitted = all types. */
  types: z.array(z.enum(ATOM_TYPES)).optional().default([]),
});

export type SubscriptionConfig = z.infer<typeof SubscriptionConfigSchema>;

export const SubscriptionRegistryFileSchema = z.object({
  version: z.literal(1).default(1),
  subscriptions: z.array(SubscriptionConfigSchema),
});

export type SubscriptionRegistry = z.infer<typeof SubscriptionRegistryFileSchema>;

export const DEFAULT_SUBSCRIPTION_REGISTRY: SubscriptionRegistry = {
  version: 1,
  subscriptions: [
    {
      id: "example-webhook",
      enabled: false,
      url: "https://example.invalid/hooks/atom",
      secret: "",
      types: ["candidate_proposed", "decision_accepted", "agent_failed"],
    },
  ],
};

export function loadSubscriptionRegistry(
  runtimePath: string,
  seedPath?: string,
): SubscriptionRegistry {
  mkdirSync(dirname(runtimePath), { recursive: true });
  if (!existsSync(runtimePath)) {
    if (seedPath && existsSync(seedPath)) copyFileSync(seedPath, runtimePath);
    else saveSubscriptionRegistry(runtimePath, DEFAULT_SUBSCRIPTION_REGISTRY);
  }
  const raw = JSON.parse(readFileSync(runtimePath, "utf8")) as unknown;
  const loaded = normalize(raw);
  const seed =
    seedPath && existsSync(seedPath)
      ? normalize(JSON.parse(readFileSync(seedPath, "utf8")) as unknown)
      : DEFAULT_SUBSCRIPTION_REGISTRY;
  const ids = new Set(loaded.subscriptions.map((s) => s.id));
  const extra = seed.subscriptions.filter((s) => !ids.has(s.id));
  if (extra.length === 0) return loaded;
  const merged: SubscriptionRegistry = {
    version: 1,
    subscriptions: [...loaded.subscriptions, ...extra],
  };
  saveSubscriptionRegistry(runtimePath, merged);
  return merged;
}

export function saveSubscriptionRegistry(path: string, registry: SubscriptionRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      SubscriptionRegistryFileSchema.parse({
        version: 1,
        subscriptions: registry.subscriptions,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function listSubscriptionConfigs(path: string, seedPath?: string): SubscriptionConfig[] {
  return loadSubscriptionRegistry(path, seedPath).subscriptions;
}

export function matchesSubscription(sub: SubscriptionConfig, atom: Atom): boolean {
  if (!sub.enabled) return false;
  if (!sub.types || sub.types.length === 0) return true;
  return sub.types.includes(atom.type as AtomType);
}

export type SubscriptionDeliver = (sub: SubscriptionConfig, atom: Atom) => Promise<void>;

/** Stage-1: log intent. No HTTP POST (no production outbound client). */
export async function stubDeliverSubscription(
  sub: SubscriptionConfig,
  atom: Atom,
): Promise<void> {
  const types = sub.types?.length ? sub.types.join(",") : "*";
  console.log(
    `[atom:sub] stub webhook ${sub.id} url=${sub.url} types=${types} atom=${atom.type} ${atom.id}`,
  );
}

/** After each append: fan-out to registered outbound endpoints. */
export async function fanoutSubscriptions(
  atom: Atom,
  subscriptions: SubscriptionConfig[],
  deliver: SubscriptionDeliver = stubDeliverSubscription,
): Promise<void> {
  for (const sub of subscriptions) {
    if (!matchesSubscription(sub, atom)) continue;
    await deliver(sub, atom);
  }
}

function normalize(raw: unknown): SubscriptionRegistry {
  if (!raw || typeof raw !== "object") return DEFAULT_SUBSCRIPTION_REGISTRY;
  const obj = raw as { subscriptions?: unknown };
  if (!Array.isArray(obj.subscriptions)) return DEFAULT_SUBSCRIPTION_REGISTRY;
  const subscriptions = obj.subscriptions
    .map((item) => SubscriptionConfigSchema.safeParse(item))
    .filter((r) => r.success)
    .map((r) => r.data);
  return SubscriptionRegistryFileSchema.parse({ version: 1, subscriptions });
}
