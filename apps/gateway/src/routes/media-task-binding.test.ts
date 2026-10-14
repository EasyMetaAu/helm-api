import type { ResponsesRegistryRecord } from "@helm/core";
import { describe, expect, it } from "vitest";
import {
  decodeMediaTaskBinding,
  encodeMediaTaskBinding,
  mediaEndpointIdentity,
  mediaTaskQueryAllowed,
} from "./media-task-binding.js";

const id = "00000000-0000-4000-8000-000000000001";
const binding = {
  version: 1 as const,
  kind: "video" as const,
  publicId: id,
  operationId: id,
  providerAlias: "bailian/video",
  providerName: "bailian",
  providerModel: "wan3.0-video",
  providerAccount: "account-a",
  laneName: "video-standard",
  profile: "bailian" as const,
  endpointIdentity: mediaEndpointIdentity("https://example.com/api/v1", "account-a", "secret-a"),
  upstreamId: "task-1",
  state: "queued" as const,
  queryExpiresAt: 86_401_000,
  artifactExpiresAt: null,
};
function record(): ResponsesRegistryRecord {
  return {
    responseId: `video:${id}`,
    accountId: "owner",
    keyId: "key",
    selectedLane: "video",
    providerAlias: binding.providerAlias,
    providerName: binding.providerName,
    providerModel: binding.providerModel,
    providerAccount: binding.providerAccount,
    providerProtocol: null,
    createdAt: 1000,
    expiresAt: 604801000,
    status: encodeMediaTaskBinding(binding),
  };
}
describe("versioned native media task binding", () => {
  it("survives persistence without leaking credentials", () => {
    const r = record();
    expect(decodeMediaTaskBinding(JSON.parse(JSON.stringify(r)))).toEqual(binding);
    expect(r.status).not.toContain("secret-a");
  });
  it.each([
    "providerName",
    "providerAlias",
    "providerModel",
    "providerAccount",
    "responseId",
    "selectedLane",
  ] as const)("rejects conflicting %s", (field) => {
    expect(decodeMediaTaskBinding({ ...record(), [field]: "changed" })).toBeNull();
  });
  it("does not reinterpret old Ark or xAI records", () => {
    expect(decodeMediaTaskBinding({ ...record(), status: "ark-media-task:v1:e30=" })).toBeNull();
    expect(decodeMediaTaskBinding({ ...record(), status: "in_progress" })).toBeNull();
  });
  it("separates query expiry from ownership and artifact expiry", () => {
    expect(mediaTaskQueryAllowed(binding, binding.endpointIdentity, 1001)).toBe(true);
    expect(mediaTaskQueryAllowed(binding, binding.endpointIdentity, binding.queryExpiresAt)).toBe(
      false,
    );
    expect(record().expiresAt).toBeGreaterThan(binding.queryExpiresAt);
    expect(binding.artifactExpiresAt).toBeNull();
  });
  it("fails closed when host, account or credential generation changes", () => {
    for (const fingerprint of [
      mediaEndpointIdentity("https://other.example/api/v1", "account-a", "secret-a"),
      mediaEndpointIdentity("https://example.com/api/v1", "account-b", "secret-a"),
      mediaEndpointIdentity("https://example.com/api/v1", "account-a", "secret-b"),
    ])
      expect(mediaTaskQueryAllowed(binding, fingerprint, 1001)).toBe(false);
  });
  it("rejects malformed or excessive binding data", () => {
    expect(decodeMediaTaskBinding({ ...record(), status: "helm-media-task:v1:???" })).toBeNull();
    expect(
      decodeMediaTaskBinding({ ...record(), status: "helm-media-task:v1:" + "a".repeat(17000) }),
    ).toBeNull();
    expect(() => encodeMediaTaskBinding({ ...binding, upstreamId: "" })).toThrow();
  });
});
