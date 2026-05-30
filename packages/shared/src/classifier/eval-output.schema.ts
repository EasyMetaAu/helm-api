import { z } from "zod";

// Layer-2 eval output schema (docs/03 §「任务分类」). The small eval model emits
// a strict JSON object judging the request's lane. This output is UNTRUSTED
// external input — it is validated here and, on any failure, the consumer
// (eval.cascade) fails open to balanced (CLAUDE.md principle 3). Zod is the
// single source of truth; `EvalOutput` is `z.infer`-ed, never hand-written.
//
// The enums are kept STRICTLY aligned with the Layer-1 classifier vocabulary
// (packages/core/src/classifier `Complexity` / `TaskType`). No lowercase /
// synonym normalization is applied anywhere — enums must match exactly so model
// drift surfaces (becomes schema_invalid → fail-open) rather than being masked.

export const ComplexitySchema = z.enum(["simple", "standard", "complex", "reasoning"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

export const TaskTypeSchema = z.enum([
  "chat",
  "coding",
  "math",
  "writing",
  "extraction",
  "tool_use",
  "vision",
  "web",
  "data",
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

// `.strict()`: any extra field (e.g. `reasoning` / `explanation` the model might
// volunteer) makes the object INVALID → fail-open, rather than silently
// accepting dirty data. `confidence` out of [0,1] is rejected, not clamped.
export const EvalOutputSchema = z
  .object({
    complexity: ComplexitySchema,
    task_type: TaskTypeSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type EvalOutput = z.infer<typeof EvalOutputSchema>;
