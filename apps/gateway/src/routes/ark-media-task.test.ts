import type { ResponsesRegistryRecord } from "@helm/core";
import { ArkPublicTaskResultSchema } from "@helm/shared";
import { expect, it } from "vitest";
import { encodeArkTaskBinding, normalizeArkTaskResult } from "./ark-media-task.js";

const publicId = "00000000-0000-4000-8000-000000000001";
const model = "doubao-seedance-2-5-260628";
const record: ResponsesRegistryRecord = {
  responseId: `video:${publicId}`,
  accountId: "account",
  keyId: "key",
  providerAlias: "ark/seedance-2.5",
  providerName: "ark",
  providerModel: model,
  providerProtocol: null,
  providerAccount: null,
  selectedLane: "video",
  createdAt: 1000,
  expiresAt: 604801000,
  status: encodeArkTaskBinding({
    kind: "video",
    publicId,
    providerAlias: "ark/seedance-2.5",
    providerAccount: null,
    laneName: "seedance-video",
    upstreamId: "task-1",
    providerName: "ark",
    providerModel: model,
    state: "queued",
  }),
};

it.each([
  "SetLimitExceeded",
  "InvalidParameter.TaskTypeConstraint",
  "InvalidParameter.TaskTypeMismatch",
])("preserves actionable Ark error code %s without returning provider message text", (code) => {
  const result = normalizeArkTaskResult(
    "video",
    {
      id: "task-1",
      model,
      status: "failed",
      content: null,
      usage: null,
      error: { code, message: "unsafe provider detail" },
    },
    record,
    publicId,
    2000,
  );
  expect(result?.error).toMatchObject({ code });
  expect(JSON.stringify(result)).not.toContain("unsafe provider detail");
  expect(ArkPublicTaskResultSchema.safeParse(result).success).toBe(true);
});
