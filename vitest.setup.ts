import { createRuntimeMemoryCoordinator } from "./packages/core/src/runtime/memory-budget.js";
import { runtimeResponseWorkAdmission } from "./packages/core/src/runtime/response-work-admission.js";

// Tests that exercise provider response parsing should not depend on the host's
// transient available-memory probe; capacity-specific cases inject their own
// admission explicitly.
runtimeResponseWorkAdmission(
  createRuntimeMemoryCoordinator({ capacityBytes: () => Number.MAX_SAFE_INTEGER }),
);
