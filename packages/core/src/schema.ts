import { z } from "zod";
import { ATOM_TYPES, REF_KINDS } from "./types.ts";

export const RefSchema = z.object({
  token: z.string().min(1),
  kind: z.enum(REF_KINDS),
  digest: z.string().min(1).optional(),
});

export const ProposedCandidateSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  confidence: z.number().min(0).max(1),
  cluster_key: z.string().min(1).optional(),
  refs: z.array(RefSchema).min(1),
});

export const ProposedCandidateListSchema = z.object({
  candidates: z.array(ProposedCandidateSchema),
});

export const AtomTypeSchema = z.enum(ATOM_TYPES);

export const ActorSchema = z.union([
  z.literal("system"),
  z.literal("llm"),
  z.string().regex(/^user:.+/),
]);

export const AtomSchema = z.object({
  id: z.string().min(1),
  type: AtomTypeSchema,
  subject_id: z.string().min(1),
  summary: z.string().min(1),
  detail: z.unknown(),
  refs: z.array(RefSchema),
  actor: ActorSchema,
  created_at: z.string().min(1),
});

export const RawMessageSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  groupId: z.string().min(1).optional(),
  author: z.string().min(1),
  text: z.string(),
  sentAt: z.string().min(1),
  token: z.string().min(1),
  cursor: z.string().min(1).optional(),
});

/** JSON Schema for Grok Build CLI `--json-schema`. */
export const proposedCandidateJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "confidence", "refs"],
        properties: {
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          cluster_key: { type: "string", minLength: 1 },
          refs: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["token", "kind"],
              properties: {
                token: { type: "string", minLength: 1 },
                kind: {
                  type: "string",
                  enum: ["im", "doc", "meeting", "file", "url", "git"],
                },
                digest: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;
