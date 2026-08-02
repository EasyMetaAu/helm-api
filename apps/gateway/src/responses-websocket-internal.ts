export const CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER = "x-helm-codex-responses-websocket-proof";

const requestMaterialized = new WeakMap<Request, () => void>();

export function trackResponsesWebSocketRequest(request: Request, materialized: () => void): void {
  requestMaterialized.set(request, materialized);
}

export function markResponsesWebSocketRequestParsed(request: Request): void {
  const materialized = requestMaterialized.get(request);
  if (materialized === undefined) return;
  requestMaterialized.delete(request);
  materialized();
}
