import type { ClassifierRulesConfig } from "@helm/shared";

type LowCostAutomationConfig = ClassifierRulesConfig["overrides"]["low_cost_automation"];

// Production monitor/cron prompts often carry a broad tool surface and a file
// path, but their intent is "check state, stay silent if nothing changed". Match
// only when an automation marker AND a no-reply marker are present, so ordinary
// questions about NO_REPLY do not get down-routed.
export function isLowCostAutomationPrompt(text: string, cfg: ClassifierRulesConfig): boolean {
  const markers = cfg.overrides.low_cost_automation ?? {
    intent_markers: [],
    no_reply_markers: [],
  };
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return (
    containsAny(trimmed, markers.intent_markers) && containsAny(trimmed, markers.no_reply_markers)
  );
}

function containsAny(text: string, markers: LowCostAutomationConfig["intent_markers"]): boolean {
  if (markers.length === 0) return false;
  const haystack = text.toLocaleLowerCase();
  return markers.some((marker) => {
    const needle = marker.trim().toLocaleLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}
