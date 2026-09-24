import {
  type ResponseWorkAdmission,
  ResponseWorkCapacityError,
  type ResponseWorkLease,
} from "../runtime/response-work-admission.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only client-executed tools are safe: a discarded attempt never reaches the client.
// Hosted tools may already have run remotely, even if no event has arrived yet.
function localTools(tools: unknown): boolean {
  return (
    tools === undefined ||
    (Array.isArray(tools) &&
      tools.every(
        (tool) =>
          record(tool) &&
          (((tool.type === "function" || tool.type === "custom") &&
            typeof tool.name === "string") ||
            (tool.type === "namespace" && Array.isArray(tool.tools) && localTools(tool.tools))),
      ))
  );
}

export type CodexRecoveryHistory = {
  responseId: string;
  model: unknown;
  input: unknown[];
  lease: Pick<ResponseWorkLease, "release">;
};

// Across all accounts sharing an admission, history cannot crowd out active streams.
const historyBytes = new WeakMap<ResponseWorkAdmission, number>();

/** One atomic delivery: failed inference attempts cannot expose tool calls or text. */
export function createCodexBufferedTurn(
  body: Record<string, unknown>,
  previous: CodexRecoveryHistory | undefined,
  admission: ResponseWorkAdmission,
  onSkip?: (reason: string) => void,
) {
  const skip = (reason: string): null => {
    onSkip?.(reason);
    return null;
  };
  if (body.store !== false) return skip("store_required_false");
  if (body.background === true) return skip("background");
  if (body.generate === false) return skip("generate_false");
  if (body.conversation != null) return skip("conversation_stateful");
  if (body.prompt != null) return skip("prompt_mode");
  if (!Array.isArray(body.input)) return skip("missing_input");
  if (!localTools(body.tools)) return skip("hosted_tools");
  const parentId = body.previous_response_id;
  if (parentId != null && (parentId !== previous?.responseId || body.model !== previous?.model))
    return skip("previous_response_mismatch");
  const input = parentId != null && previous ? [...previous.input, ...body.input] : body.input;
  const inputTypes = new Set([
    "message",
    "reasoning",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "additional_tools",
    "compaction",
  ]);
  if (
    input.some(
      (item) =>
        !record(item) ||
        (item.type !== undefined && !inputTypes.has(String(item.type))) ||
        (item.type === "additional_tools" &&
          (!Array.isArray(item.tools) || !localTools(item.tools))),
    )
  )
    return skip("unsupported_input");
  const inputBytes = Buffer.byteLength(JSON.stringify(input));
  const acquired = admission.acquire(inputBytes);
  if (!acquired.ok) return skip("response_work_capacity_exhausted");
  const lease = acquired.lease;
  let bytes = inputBytes;
  const frames: string[] = [];
  const output = new Map<number, Record<string, unknown>>();
  let replaySafe = true;
  let sawOutput = false;
  const pendingItems = new Set<number>();
  const outputTypes = new Set(["message", "reasoning", "function_call", "custom_tool_call"]);
  return {
    input,
    get replaySafe() {
      return replaySafe;
    },
    append(frame: string, event: Record<string, unknown>) {
      bytes += Buffer.byteLength(frame);
      if (!lease.resize(bytes).ok) throw new ResponseWorkCapacityError(admission.capacityBytes);
      frames.push(frame);
      const type = String(event.type);
      if (type.includes(".delta") || type === "response.output_item.added") sawOutput = true;
      if (type === "response.output_item.added" && Number.isInteger(event.output_index))
        pendingItems.add(Number(event.output_index));
      // Unknown/server-side activity is never replayed, even with incomplete tool declarations.
      if (
        !/^(response\.(created|in_progress|completed|incomplete|failed|cancelled|output_item\.(added|done)|content_part\.(added|done)|output_text\.(delta|done|annotation\.added)|refusal\.(delta|done)|reasoning(_summary)?(_text)?\.(delta|done)|reasoning_summary_part\.(added|done)|function_call_arguments\.(delta|done)|custom_tool_call_input\.(delta|done))|error|codex\.response\.metadata|responsesapi\.websocket_timing)$/.test(
          type,
        )
      )
        replaySafe = false;
      if (
        (type === "response.output_item.added" || type === "response.output_item.done") &&
        (!record(event.item) || !outputTypes.has(String(event.item.type)))
      )
        replaySafe = false;
      if (
        type === "response.output_item.done" &&
        record(event.item) &&
        Number.isInteger(event.output_index)
      ) {
        output.set(Number(event.output_index), event.item);
        pendingItems.delete(Number(event.output_index));
      }
    },
    frames,
    reset() {
      frames.length = 0;
      output.clear();
      bytes = inputBytes;
      replaySafe = true;
      sawOutput = false;
      pendingItems.clear();
      lease.resize(bytes);
    },
    snapshot(event: Record<string, unknown>): CodexRecoveryHistory | null {
      if (
        event.type !== "response.completed" ||
        !record(event.response) ||
        typeof event.response.id !== "string" ||
        !replaySafe
      )
        return null;
      const finalOutput = event.response.output;
      if (
        (!Array.isArray(finalOutput) || finalOutput.length === 0) &&
        (pendingItems.size > 0 ||
          (sawOutput && output.size === 0) ||
          [...output.keys()].sort((a, b) => a - b).some((index, n) => index !== n))
      )
        return null;
      const items =
        Array.isArray(event.response.output) && event.response.output.length > 0
          ? event.response.output
          : [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      // Opaque reasoning must be preserved, never reconstructed from summaries.
      if (
        items.some(
          (item) =>
            !record(item) ||
            !outputTypes.has(String(item.type)) ||
            (item.type === "reasoning" && typeof item.encrypted_content !== "string"),
        )
      )
        return null;
      const historyInput = [...input, ...items];
      const encoded = JSON.stringify(historyInput);
      const before = admission.reservedBytes;
      const held = admission.acquire(Buffer.byteLength(encoded));
      if (!held.ok) return null;
      const charge = admission.reservedBytes - before;
      const cached = historyBytes.get(admission) ?? 0;
      if (cached + charge > admission.capacityBytes / 4) {
        held.lease.release();
        return null;
      }
      historyBytes.set(admission, cached + charge);
      let released = false;
      return {
        responseId: event.response.id,
        model: body.model,
        input: JSON.parse(encoded) as unknown[],
        lease: {
          release() {
            if (released) return;
            released = true;
            historyBytes.set(admission, (historyBytes.get(admission) ?? charge) - charge);
            held.lease.release();
          },
        },
      };
    },
    release() {
      frames.length = 0;
      output.clear();
      lease.release();
    },
  };
}
