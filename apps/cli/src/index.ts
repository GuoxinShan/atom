import {
  decideOnStore,
  describeUnboundKind,
  digest,
  executeTrigger,
  extract,
  ingest,
  listSourceConfigs,
  listTriggerConfigs,
  projectCandidates,
  resolveManualTrigger,
  resolvePaths,
  SourceConfigSchema,
  upsertSourceConfig,
} from "@atom/core";
import { createPipeline, describeSource, registeredSourceTypes } from "@atom/adapters";

const USAGE = `ATOM — Append-only Timeline Of Matters · 事元

  pnpm atom run              ingest + extract + markdown digest
  pnpm atom ingest
  pnpm atom extract
  pnpm atom digest
  pnpm atom candidates
  pnpm atom approve <id>
  pnpm atom reject <id>
  pnpm atom sources list
  pnpm atom sources add --id <id> --type <type> [--group-id <gid> ...]
  pnpm atom triggers list

Default: enabled sources from data/sources.json; manual trigger from data/triggers.json
         extract: heuristic. Set ATOM_EXTRACT_AGENT=grok for Grok CLI.
Env: ATOM_SOURCE=<config id>     run one source
     ATOM_EXTRACT_AGENT=heuristic|grok
     ATOM_GROK_BIN ATOM_GROK_MODEL ATOM_GROK_MAX_TURNS
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "sources") {
    sourcesCommand(rest);
    return;
  }
  if (cmd === "triggers") {
    triggersCommand(rest);
    return;
  }

  const { pipeline, store } = createPipeline();
  try {
    switch (cmd) {
      case "run": {
        const trigger = resolveManualTrigger(
          resolvePaths().triggerRegistryPath,
          resolvePaths().seedTriggerRegistryPath,
        );
        const result = await executeTrigger(pipeline, trigger);
        console.log(
          `run ok  trigger=${trigger.id} ingested=${result.ingested ?? 0} proposed=${result.proposed ?? 0}\ndigest ${result.digestPath ?? ""}`,
        );
        break;
      }
      case "ingest": {
        const r = await ingest(pipeline);
        console.log(`ingest ok  ingested=${r.ingested} skipped=${r.skipped}`);
        break;
      }
      case "extract": {
        const r = await extract(pipeline);
        console.log(`extract ok  proposed=${r.proposed} skipped=${r.skipped}`);
        break;
      }
      case "digest": {
        const r = digest(pipeline);
        console.log(`digest ${r.path}  candidates=${r.candidates.length}`);
        break;
      }
      case "candidates": {
        const list = projectCandidates(store.listAll());
        if (list.length === 0) {
          console.log("no candidates — run `pnpm atom run` first");
          break;
        }
        for (const c of list) {
          const refs = c.refs.map((r) => r.token).join(" ");
          console.log(
            `${c.status.padEnd(10)}  ${c.id}  ${c.confidence.toFixed(2)}  ${c.title}\n            refs: ${refs}`,
          );
        }
        break;
      }
      case "approve":
      case "reject": {
        const id = rest[0];
        if (!id) throw new Error(`${cmd} requires a candidate id`);
        const updated = decideOnStore(
          store,
          id,
          cmd === "approve" ? "accepted" : "rejected",
          rest.slice(1).join(" ") || undefined,
        );
        digest(pipeline);
        console.log(`${updated.status}  ${updated.id}  ${updated.title}`);
        break;
      }
      case "ui":
        throw new Error("Kanban UI is out of this PR — CLI only. See docs/06-extensibility.md.");
      default:
        throw new Error(`unknown command: ${cmd}\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

function sourcesCommand(argv: string[]): void {
  const [sub, ...rest] = argv;
  const paths = resolvePaths();
  if (!sub || sub === "list") {
    const rows = listSourceConfigs(paths.registryPath, paths.seedRegistryPath);
    console.log(`registry ${paths.registryPath}`);
    console.log(`factories ${registeredSourceTypes().join(", ") || "(none)"}`);
    if (rows.length === 0) {
      console.log("(empty) — pnpm atom sources add --id … --type …");
      return;
    }
    for (const row of rows) console.log(describeSource(row));
    return;
  }
  if (sub === "add") {
    const flags = parseFlags(rest);
    const id = first(flags.id);
    const type = first(flags.type);
    if (!id || !type) {
      throw new Error("sources add requires --id and --type");
    }
    const enabledRaw = first(flags.enabled);
    const parsed = SourceConfigSchema.parse({
      id,
      type,
      enabled: enabledRaw ? enabledRaw !== "false" : true,
      label: first(flags.label),
      credentialRef: first(flags["credential-ref"]),
      groupIds: flags["group-id"],
      settings: {
        ...(first(flags.bin) ? { bin: first(flags.bin) } : {}),
        ...(first(flags.path) ? { path: first(flags.path) } : {}),
      },
    });
    upsertSourceConfig(paths.registryPath, parsed, paths.seedRegistryPath);
    if (!registeredSourceTypes().includes(type)) {
      console.warn(
        `saved ${id} type=${type} with no factory yet. registerSourceType("${type}", …) before ingest.`,
      );
    }
    console.log(`saved ${id} → ${paths.registryPath}`);
    return;
  }
  throw new Error(`unknown sources subcommand: ${sub}\n  sources list | sources add --id --type`);
}

function triggersCommand(argv: string[]): void {
  const [sub] = argv;
  const paths = resolvePaths();
  if (!sub || sub === "list") {
    const rows = listTriggerConfigs(paths.triggerRegistryPath, paths.seedTriggerRegistryPath);
    console.log(`registry ${paths.triggerRegistryPath}`);
    if (rows.length === 0) {
      console.log("(empty)");
      return;
    }
    for (const t of rows) {
      const on = t.enabled ? "on" : "off";
      console.log(
        `${t.id}\t${t.kind}\t${on}\tpipeline=${t.pipeline}\t${describeUnboundKind(t.kind)}`,
      );
    }
    return;
  }
  throw new Error(`unknown triggers subcommand: ${sub}\n  triggers list`);
}

function parseFlags(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok?.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i += 1;
    (out[key] ??= []).push(val);
  }
  return out;
}

function first(values: string[] | undefined): string | undefined {
  return values?.[0];
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
