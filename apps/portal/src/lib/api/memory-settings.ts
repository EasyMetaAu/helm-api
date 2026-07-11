import type { Me } from "./portal";

export type ActiveMemoryMode = "observe" | "inject";

export interface MemorySettingsForm {
  enabled: boolean;
  activeMode: ActiveMemoryMode;
  projectName: string;
}

export function toMemorySettingsForm(
  memory: Pick<Me["memory"], "mode" | "project_name">,
): MemorySettingsForm {
  return {
    enabled: memory.mode !== "off",
    activeMode: memory.mode === "observe" ? "observe" : "inject",
    projectName: memory.project_name ?? "",
  };
}

export function toMemorySettingsRequest(form: MemorySettingsForm): {
  memory_mode: "off" | ActiveMemoryMode;
  memory_project_id: string | null;
} {
  return {
    memory_mode: form.enabled ? form.activeMode : "off",
    memory_project_id: form.projectName.trim() || null,
  };
}
