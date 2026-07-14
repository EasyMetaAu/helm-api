// Normalize Gemini image-generation usage into the OpenAI-shaped body consumed by
// the shared cost engine. Gemini reports candidate modalities separately; image
// tokens have a much higher rate than text/thinking tokens, so flattening the
// whole candidate count into IMAGE is materially wrong for mixed responses.

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function modalityTokens(details: unknown, modality: string): number | undefined {
  if (!Array.isArray(details)) return undefined;
  let total = 0;
  let found = false;
  for (const item of details) {
    if (!item || typeof item !== "object") continue;
    const row = item as { modality?: unknown; tokenCount?: unknown };
    if (typeof row.modality !== "string" || row.modality.toUpperCase() !== modality) continue;
    const count = tokenCount(row.tokenCount);
    if (count === undefined) continue;
    total += count;
    found = true;
  }
  return found ? total : undefined;
}

export function geminiImageUsageBody(usageMetadata: Record<string, unknown>): {
  usage: Record<string, unknown>;
} {
  const inputTokens = tokenCount(usageMetadata.promptTokenCount);
  const cachedTokens = tokenCount(usageMetadata.cachedContentTokenCount);
  const candidateTokens = tokenCount(usageMetadata.candidatesTokenCount);
  const reasoningTokens = tokenCount(usageMetadata.thoughtsTokenCount) ?? 0;
  const detail = usageMetadata.candidatesTokensDetails;
  const hasCandidateModalityDetails =
    Array.isArray(detail) &&
    detail.some(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as { modality?: unknown }).modality === "string" &&
        tokenCount((item as { tokenCount?: unknown }).tokenCount) !== undefined,
    );
  const detailImageTokens = modalityTokens(detail, "IMAGE");
  const textTokens = modalityTokens(detail, "TEXT");
  // When the provider omits candidatesTokensDetails, the TEXT/IMAGE partition is
  // unknowable. Leave image_tokens absent so the split-rate cost engine returns
  // null rather than overcharging every candidate token at the image rate.
  const imageTokens = detailImageTokens ?? (hasCandidateModalityDetails ? 0 : undefined);
  const outputTokens =
    candidateTokens !== undefined
      ? candidateTokens + reasoningTokens
      : reasoningTokens || undefined;

  return {
    usage: {
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined
        ? {
            output_tokens: outputTokens,
            ...(imageTokens !== undefined || textTokens !== undefined || reasoningTokens > 0
              ? {
                  output_tokens_details: {
                    ...(imageTokens !== undefined ? { image_tokens: imageTokens } : {}),
                    ...(textTokens !== undefined ? { text_tokens: textTokens } : {}),
                    ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
                  },
                }
              : {}),
          }
        : {}),
      ...(cachedTokens !== undefined
        ? { input_tokens_details: { cached_tokens: cachedTokens } }
        : {}),
    },
  };
}
