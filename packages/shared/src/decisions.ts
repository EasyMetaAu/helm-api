import { z } from "zod";

// Deliberately reviewed allowlist; latest may resolve to a newer version upstream.
export const JevModelSchema = z.enum([
  "~typesafe/jev-latest",
  "typesafe/jev-1.13",
  "typesafe/jev-1.13-20260917",
]);
const name = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !["__proto__", "constructor", "prototype"].includes(s));
const guidance = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const criteria = z
  .record(name, guidance.nullable())
  .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 128);
const question = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("noul"),
      instructions: guidance,
      criteria: z.object({ true: guidance, false: guidance }).strict().optional(),
    })
    .strict(),
  z.object({ type: z.literal("choice"), instructions: guidance, criteria }).strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: guidance,
      criteria: z.array(guidance).min(1).max(128),
    })
    .strict(),
]);
export const DecisionsRequestSchema = z
  .object({
    model: JevModelSchema,
    state: guidance,
    questions: z
      .record(name, question)
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 64),
  })
  .strict();
export type DecisionsRequest = z.infer<typeof DecisionsRequestSchema>;
const probability = z.number().finite().min(0).max(1);
const distribution = z
  .record(name, probability)
  .refine((v) => Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 1) <= 0.001);
const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: name,
    confidence: probability,
    probabilities: distribution,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite().nonnegative(),
    confidence: probability,
    probabilities: distribution,
    legend: z.record(name, guidance).optional(),
  }),
]);
const usage = z.object({
  input_tokens: z.number().int().nonnegative().nullable().default(null),
  output_tokens: z.number().int().nonnegative().nullable().default(null),
  cost: z.number().finite().nonnegative().nullable().default(null),
});
export const DecisionsResponseSchema = z.object({
  id: z.string().max(256).optional(),
  model: z.string().regex(/^typesafe\/jev-\d+\.\d+(?:-\d{8})?$/),
  provider: z.string().max(128).optional(),
  answers: z.record(name, answer),
  usage: usage
    .nullish()
    .transform((v) => v ?? { input_tokens: null, output_tokens: null, cost: null }),
});
export type DecisionsResponse = z.infer<typeof DecisionsResponseSchema>;
export const DecisionsEnvelopeSchema = DecisionsResponseSchema.extend({
  usage,
  requested_model: JevModelSchema,
  trace_id: z.string(),
  request_id: z.string(),
  content_retention: z.literal("none"),
});

/** Validate the upstream answer against the submitted questions, never repair probabilities. */
export function validateDecisionsResponse(
  request: DecisionsRequest,
  raw: unknown,
): DecisionsResponse {
  const result = DecisionsResponseSchema.parse(raw);
  const sameKeys = (a: string[], b: string[]) =>
    a.length === b.length && a.every((key) => b.includes(key));
  const invalid = () => {
    throw new Error("invalid Jev answer contract");
  };
  if (!sameKeys(Object.keys(request.questions), Object.keys(result.answers))) invalid();
  if (
    request.model !== "~typesafe/jev-latest" &&
    result.model !== request.model &&
    !result.model.startsWith(`${request.model}-`)
  )
    invalid();
  for (const [id, q] of Object.entries(request.questions)) {
    const a = result.answers[id];
    if (!a || a.type !== q.type) {
      invalid();
      continue;
    }
    if (q.type === "choice" && a.type === "choice") {
      if (
        !Object.hasOwn(q.criteria, a.choice) ||
        !sameKeys(Object.keys(q.criteria), Object.keys(a.probabilities))
      )
        invalid();
      if ((a.probabilities[a.choice] ?? -1) + 0.001 < Math.max(...Object.values(a.probabilities)))
        invalid();
    }
    if (q.type === "score" && a.type === "score") {
      const levels = q.criteria.map((_, i) => String(i));
      if (a.score > q.criteria.length - 1 || !sameKeys(levels, Object.keys(a.probabilities)))
        invalid();
      if (a.legend && !sameKeys(levels, Object.keys(a.legend))) invalid();
      const mean = Object.entries(a.probabilities).reduce(
        (sum, [level, p]) => sum + Number(level) * p,
        0,
      );
      // Upstream examples round scores to two decimals.
      if (Math.abs(a.score - mean) > 0.01) invalid();
    }
  }
  return result;
}
