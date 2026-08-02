import {
  type RuntimeMemoryCoordinator,
  type RuntimeMemoryLease,
  runtimeMemoryBudget,
  runtimeMemoryCoordinator,
} from "./memory-budget.js";

export class ResponseWorkCapacityError extends Error {
  constructor(readonly capacityBytes: number) {
    super("upstream response memory capacity is temporarily exhausted");
    this.name = "ResponseWorkCapacityError";
  }
}

export interface ResponseWorkLease {
  resize(wireBytes: number): { ok: true } | { ok: false; reason: "busy" };
  release(): void;
}

export interface ResponseWorkAdmission {
  acquire(
    wireBytes: number,
  ): { ok: true; lease: ResponseWorkLease } | { ok: false; reason: "busy" };
  readonly capacityBytes: number;
  readonly reservedBytes: number;
}

export function createResponseWorkAdmission(options: {
  capacityBytes: number;
  dynamicCapacityBytes?: () => number;
  jsonAmplification: number;
  minChargeBytes: number;
  coordinator?: RuntimeMemoryCoordinator;
}): ResponseWorkAdmission {
  const configuredCapacityBytes = Math.max(1, Math.floor(options.capacityBytes));
  const capacityBytes = (): number =>
    Math.max(0, Math.floor(options.dynamicCapacityBytes?.() ?? configuredCapacityBytes));
  const minChargeBytes = Math.max(1, Math.floor(options.minChargeBytes));
  let reservedBytes = 0;
  const charge = (wireBytes: number): number =>
    Math.max(minChargeBytes, Math.ceil(Math.max(0, wireBytes) * options.jsonAmplification));

  return {
    acquire(wireBytes) {
      let held = charge(wireBytes);
      const shared = options.coordinator?.acquire(held);
      if (shared !== undefined && !shared.ok) {
        return { ok: false as const, reason: "busy" as const };
      }
      if (shared === undefined && reservedBytes + held > capacityBytes()) {
        return { ok: false as const, reason: "busy" as const };
      }
      let sharedLease: RuntimeMemoryLease | undefined =
        shared?.ok === true ? shared.lease : undefined;
      reservedBytes += held;
      let released = false;
      return {
        ok: true as const,
        lease: {
          resize(nextWireBytes) {
            if (released) return { ok: false as const, reason: "busy" as const };
            const next = charge(nextWireBytes);
            if (sharedLease !== undefined) {
              if (!sharedLease.resize(next).ok) {
                return { ok: false as const, reason: "busy" as const };
              }
            } else if (next > held && reservedBytes - held + next > capacityBytes()) {
              return { ok: false as const, reason: "busy" as const };
            }
            reservedBytes += next - held;
            held = next;
            return { ok: true as const };
          },
          release() {
            if (released) return;
            released = true;
            sharedLease?.release();
            sharedLease = undefined;
            reservedBytes -= held;
          },
        },
      };
    },
    get capacityBytes() {
      return capacityBytes();
    },
    get reservedBytes() {
      return reservedBytes;
    },
  };
}

let detected: ResponseWorkAdmission | undefined;

export function runtimeResponseWorkAdmission(): ResponseWorkAdmission {
  if (detected !== undefined) return detected;
  const budget = runtimeMemoryBudget();
  detected = createResponseWorkAdmission({
    capacityBytes: budget.responseWorkBytes,
    jsonAmplification: budget.jsonAmplification,
    minChargeBytes: budget.minRequestChargeBytes,
    coordinator: runtimeMemoryCoordinator(),
  });
  return detected;
}

export function acquireResponseWork(
  admission: ResponseWorkAdmission,
  wireBytes: number,
): ResponseWorkLease {
  const acquired = admission.acquire(wireBytes);
  if (!acquired.ok) throw new ResponseWorkCapacityError(admission.capacityBytes);
  return acquired.lease;
}
