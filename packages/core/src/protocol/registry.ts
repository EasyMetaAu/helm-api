import type { Transformer } from "./transformer.js";

// Transformer registry + framework-agnostic endpoint mounting (docs/05; modeled
// on musistudio/llms index.ts/server.ts). Indexes transformers by protocol name
// and, separately, by the inbound `endPoint` each declares. Per CLAUDE.md
// principle 1 the mounting layer does NOT import Hono: it produces abstract
// { endPoint, name } descriptions that the gateway turns into real routes.

/** Thrown when a transformer name is registered twice (fail-closed, principle 2). */
export class DuplicateTransformerError extends Error {
  readonly transformerName: string;
  constructor(transformerName: string) {
    super(`transformer "${transformerName}" is already registered`);
    this.name = "DuplicateTransformerError";
    this.transformerName = transformerName;
  }
}

/** Thrown when two transformers claim the same inbound endPoint (fail-closed). */
export class DuplicateEndpointError extends Error {
  readonly endPoint: string;
  constructor(endPoint: string) {
    super(`endPoint "${endPoint}" is already claimed by another transformer`);
    this.name = "DuplicateEndpointError";
    this.endPoint = endPoint;
  }
}

export class TransformerRegistry {
  private readonly byName = new Map<string, Transformer>();
  private readonly byEndpoint = new Map<string, Transformer>();

  /**
   * Register a transformer. A duplicate `name` or `endPoint` throws (fail-closed)
   * rather than silently overwriting — a shadowed transformer would route to the
   * wrong protocol.
   */
  register(t: Transformer): void {
    if (this.byName.has(t.name)) {
      throw new DuplicateTransformerError(t.name);
    }
    if (t.endPoint !== undefined && this.byEndpoint.has(t.endPoint)) {
      throw new DuplicateEndpointError(t.endPoint);
    }
    this.byName.set(t.name, t);
    if (t.endPoint !== undefined) {
      this.byEndpoint.set(t.endPoint, t);
    }
  }

  get(name: string): Transformer | undefined {
    return this.byName.get(name);
  }

  /** All transformers that declare an inbound endPoint (for the mounting layer). */
  endpoints(): ReadonlyArray<{ endPoint: string; transformer: Transformer }> {
    const out: Array<{ endPoint: string; transformer: Transformer }> = [];
    for (const [endPoint, transformer] of this.byEndpoint) {
      out.push({ endPoint, transformer });
    }
    return out;
  }
}

/**
 * Mounting layer: hands the registry's inbound endpoints to the host (gateway)
 * as abstract { endPoint, name } descriptions. Framework-agnostic — the real
 * `app.post(endPoint, ...)` wiring is the gateway's job (CLAUDE.md principle 1).
 */
export function mountEndpoints(
  registry: TransformerRegistry,
): ReadonlyArray<{ endPoint: string; name: string }> {
  return registry.endpoints().map(({ endPoint, transformer }) => ({
    endPoint,
    name: transformer.name,
  }));
}
