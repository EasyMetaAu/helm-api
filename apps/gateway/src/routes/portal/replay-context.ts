import { AsyncLocalStorage } from "node:async_hooks";

// An internal execution context, never a client-settable header. The normal
// auth/budget gates use it to refresh key state and reject exhausted budgets.
export const portalReplayKey = new AsyncLocalStorage<string>();
