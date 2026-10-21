import { z } from "zod";

// Only protocol identifiers, never tool arguments or results. Stored with the
// response's existing owner/provider binding, not in client request metadata.
export const ResponsesToolTranslationSchema = z.object({
  toolNames: z.array(z.string().min(1).max(256)).max(256),
  pendingCallIds: z.array(z.string().min(1).max(512)).max(1024),
});
export type ResponsesToolTranslation = z.infer<typeof ResponsesToolTranslationSchema>;

// A request-local reference whose state becomes available when its stream ends.
export interface ResponsesToolTranslationCapture {
  state?: ResponsesToolTranslation;
}
