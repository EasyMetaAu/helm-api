import type { MemoryJobStatus, MemoryStore } from "../store/ports.js";

export interface ClaimedMemoryJob {
  jobId: string;
  leaseGeneration?: number;
}

export function updateClaimedJobStatus(
  store: MemoryStore,
  job: ClaimedMemoryJob,
  status: MemoryJobStatus,
  error?: string,
): Promise<void> {
  if (job.leaseGeneration !== undefined) {
    return store.updateJobStatus(job.jobId, status, error, job.leaseGeneration);
  }
  return error === undefined
    ? store.updateJobStatus(job.jobId, status)
    : store.updateJobStatus(job.jobId, status, error);
}
