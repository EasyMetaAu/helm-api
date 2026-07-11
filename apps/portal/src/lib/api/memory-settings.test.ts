import { describe, expect, it } from "vitest";
import {
  toMemorySettingsForm,
  toMemorySettingsRequest,
} from "./memory-settings";

describe("Memory settings dialog mapping", () => {
  it("restores inject as the active mode when Memory is currently off", () => {
    expect(toMemorySettingsForm({ mode: "off", project_name: null })).toEqual({
      enabled: false,
      activeMode: "inject",
      projectName: "",
    });
  });

  it("preserves observe mode and the configured project", () => {
    expect(
      toMemorySettingsForm({ mode: "observe", project_name: "project-a" }),
    ).toEqual({
      enabled: true,
      activeMode: "observe",
      projectName: "project-a",
    });
  });

  it("maps the dialog form to the strict API request and trims the project", () => {
    expect(
      toMemorySettingsRequest({
        enabled: true,
        activeMode: "inject",
        projectName: "  project-a  ",
      }),
    ).toEqual({ memory_mode: "inject", memory_project_id: "project-a" });
    expect(
      toMemorySettingsRequest({
        enabled: false,
        activeMode: "observe",
        projectName: "   ",
      }),
    ).toEqual({ memory_mode: "off", memory_project_id: null });
  });
});
