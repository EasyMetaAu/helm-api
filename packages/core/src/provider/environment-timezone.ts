import {
  appendMutationList,
  cloneCarrierWithBody,
  IanaTimezoneSchema,
  isNativePassthroughCarrier,
  type NativePassthroughInput,
  nativePassthroughBody,
} from "@helm/shared";

export type EnvironmentTimezoneResolver = () => Promise<string | null>;
const datePattern = "\\d{4}-\\d{2}-\\d{2}";
const codexDate = new RegExp(`<current_date>${datePattern}</current_date>`, "g");
const codexZone = /<timezone>([^<>]+)<\/timezone>/g;
const claudeDate = new RegExp(
  `^(<system-reminder>\\s*Today's date is )${datePattern}(\\.\\s*</system-reminder>)$`,
);
const grokInfo = new RegExp(
  `^(<user_info>\\nOS Version: [^\\n]+\\nShell: [^\\n]+\\nWorkspace Path: [^\\n]+\\nToday's date: )${datePattern}(\\n</user_info>)(?=\\s|$)`,
);

const grokRollover = new RegExp(
  `^(<system-reminder>\\s*The local date has changed since this session started\\. Today's date is now )(${datePattern})(\\. Any date shown earlier in this session was set at startup and is now stale; use )\\2( as the current date\\.\\s*</system-reminder>)$`,
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only known client framing at a user-message text boundary. Never walk arbitrary
// strings, tools, assistant output, search locations or scheduling instructions.
function kind(text: string): "codex" | "claude" | "grok" | null {
  if (/^<environment_context>\s[\s\S]*\s<\/environment_context>$/.test(text)) {
    const dates = [...text.matchAll(codexDate)];
    const zones = [...text.matchAll(codexZone)];
    if (
      dates.length === 1 &&
      zones.length === 1 &&
      IanaTimezoneSchema.safeParse(zones[0]?.[1]).success
    )
      return "codex";
  }
  if (claudeDate.test(text)) return "claude";
  if (grokInfo.test(text) || grokRollover.test(text)) return "grok";
  return null;
}

function candidates(body: Record<string, unknown>) {
  const result: {
    key: "input" | "messages";
    index: number;
    part: number | null;
    text: string;
    kind: NonNullable<ReturnType<typeof kind>>;
  }[] = [];
  for (const key of ["input", "messages"] as const) {
    const messages = body[key];
    if (!Array.isArray(messages)) continue;
    messages.forEach((message, index) => {
      if (
        !record(message) ||
        message.role !== "user" ||
        (message.type !== undefined && message.type !== "message")
      )
        return;
      const add = (text: string, part: number | null) => {
        const found = kind(text);
        if (found) result.push({ key, index, part, text, kind: found });
      };
      if (typeof message.content === "string") add(message.content, null);
      else if (Array.isArray(message.content))
        message.content.forEach((part, i) => {
          if (
            record(part) &&
            (part.type === "text" || part.type === "input_text") &&
            typeof part.text === "string"
          )
            add(part.text, i);
        });
    });
  }
  // Earlier environment blocks describe earlier turns; replacing their dates
  // with today's date would falsify history. Only update the latest of each kind.
  return result.filter((entry, i) => !result.slice(i + 1).some((next) => next.kind === entry.kind));
}

export function rewriteEnvironmentInput(
  input: NativePassthroughInput,
  timezone: string,
  now = new Date(),
): NativePassthroughInput {
  if (!IanaTimezoneSchema.safeParse(timezone).success) return input;
  const source = nativePassthroughBody(input);
  const matches = candidates(source);
  if (matches.length === 0) return input;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const body = { ...source };
  let changed = false;
  for (const match of matches) {
    const text =
      match.kind === "codex"
        ? match.text
            .replace(codexDate, `<current_date>${date}</current_date>`)
            .replace(codexZone, () => `<timezone>${timezone}</timezone>`)
        : grokRollover.test(match.text)
          ? match.text.replace(
              grokRollover,
              (_all, before: string, _old: string, middle: string, after: string) =>
                `${before}${date}${middle}${date}${after}`,
            )
          : match.text.replace(
              match.kind === "claude" ? claudeDate : grokInfo,
              (_all, before: string, after: string) => `${before}${date}${after}`,
            );
    if (text === match.text) continue;
    changed = true;
    const list = [...(body[match.key] as Record<string, unknown>[])];
    const message = { ...list[match.index] };
    if (match.part === null) message.content = text;
    else {
      const content = [...(message.content as Record<string, unknown>[])];
      content[match.part] = { ...content[match.part], text };
      message.content = content;
    }
    list[match.index] = message;
    body[match.key] = list;
  }
  if (!changed) return input;
  if (!isNativePassthroughCarrier(input)) return body;
  const carrier = cloneCarrierWithBody(input, body);
  appendMutationList(carrier.mutations, "body_shims_applied", ["client_environment_timezone"]);
  return carrier;
}

export async function applyEnvironmentTimezone(
  input: NativePassthroughInput,
  resolve?: EnvironmentTimezoneResolver,
): Promise<NativePassthroughInput> {
  if (!resolve || candidates(nativePassthroughBody(input)).length === 0) return input;
  // IP discovery is an auxiliary signal; failure must neither invent a timezone
  // nor prevent inference. Persisted manual overrides are validated at the API.
  try {
    const timezone = await resolve();
    return timezone ? rewriteEnvironmentInput(input, timezone) : input;
  } catch {
    return input;
  }
}
