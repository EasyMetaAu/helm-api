import { decryptSecret, encryptSecret, transcriptionOperationStoreId } from "@helm/core";
import { type AudioTranscriptionResult, AudioTranscriptionResultSchema } from "@helm/shared";
import { z } from "zod";
import type { AtomicResponsesRegistryPort } from "../responses-registry.js";
import type { MessagesIdentity } from "./messages.js";

export const TRANSCRIPTION_RESULT_ID_PREFIX = "audio-transcription-result:";
const retentionMs = 6 * 60 * 60 * 1000;
const maxPlaintextBytes = 512 * 1024;
const maxCiphertextLength = 4 * Math.ceil((maxPlaintextBytes + 28) / 3) + 3;

const selectionSchema = z.strictObject({
  requestedModel: z.string().min(1).max(256),
  alias: z.string().min(1),
  model: z.string().min(1),
  lane: z.string().min(1),
  customModel: z.boolean(),
});
const payloadSchema = z.strictObject({
  id: z.string(),
  accountId: z.string(),
  expiresAt: z.number().int(),
  selection: selectionSchema,
  result: AudioTranscriptionResultSchema,
});

export type TranscriptionResultSelection = z.infer<typeof selectionSchema>;
export interface TranscriptionResultStore {
  save(
    id: string,
    identity: MessagesIdentity,
    selection: TranscriptionResultSelection,
    result: AudioTranscriptionResult,
  ): Promise<void>;
  get(
    id: string,
    identity: MessagesIdentity,
  ): Promise<Pick<z.infer<typeof payloadSchema>, "result" | "selection"> | null>;
}

export function createTranscriptionResultStore(
  registry: Pick<AtomicResponsesRegistryPort, "putIfAbsent" | "get">,
  encryptionKey: Buffer,
  now = Date.now,
): TranscriptionResultStore {
  const recordId = (id: string, identity: MessagesIdentity) =>
    TRANSCRIPTION_RESULT_ID_PREFIX + transcriptionOperationStoreId(id, identity.keyId);
  return {
    async save(id, identity, selection, result) {
      const responseId = recordId(id, identity);
      const createdAt = now();
      const expiresAt = createdAt + retentionMs;
      const plaintext = JSON.stringify(
        payloadSchema.parse({
          id: responseId,
          accountId: identity.accountId,
          expiresAt,
          selection,
          result,
        }),
      );
      if (Buffer.byteLength(plaintext) > maxPlaintextBytes)
        throw new Error("transcription result exceeds the storage limit");
      const inserted = await registry.putIfAbsent({
        responseId,
        accountId: identity.accountId,
        keyId: identity.keyId,
        providerAlias: null,
        providerName: null,
        providerModel: null,
        providerProtocol: null,
        selectedLane: "transcription",
        createdAt,
        expiresAt,
        status: encryptSecret(plaintext, encryptionKey),
      });
      if (!inserted) throw new Error("transcription result storage collision");
    },
    async get(id, identity) {
      const responseId = recordId(id, identity);
      const record = await registry.get(responseId, identity);
      if (!record || record.expiresAt <= now()) return null;
      if (record.status.length > maxCiphertextLength)
        throw new Error("invalid stored transcription result");
      const payload = payloadSchema.parse(JSON.parse(decryptSecret(record.status, encryptionKey)));
      if (
        payload.id !== responseId ||
        payload.accountId !== identity.accountId ||
        payload.expiresAt !== record.expiresAt
      )
        throw new Error("invalid stored transcription binding");
      return { result: payload.result, selection: payload.selection };
    },
  };
}
