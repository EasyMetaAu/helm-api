import { describe, expect, it } from "vitest";
import {
  toMemorySettingsForm,
  toMemorySettingsRequest,
} from "./memory-settings";

describe("Memory settings dialog mapping", () => {
  it("restores inject as the active mode when Memory is currently off", () => {
    expect(
      toMemorySettingsForm({
        mode: "off",
        project_name: null,
        thread_source: "header",
      }),
    ).toEqual({
      enabled: false,
      activeMode: "inject",
      projectName: "",
      threadSource: "header",
    });
  });

  it("preserves observe mode and the configured project", () => {
    expect(
      toMemorySettingsForm({
        mode: "observe",
        project_name: "project-a",
        thread_source: "auto",
      }),
    ).toEqual({
      enabled: true,
      activeMode: "observe",
      projectName: "project-a",
      threadSource: "auto",
    });
  });

  it("maps the dialog form to the strict API request and trims the project", () => {
    expect(
      toMemorySettingsRequest({
        enabled: true,
        activeMode: "inject",
        projectName: "  project-a  ",
        threadSource: "auto",
      }),
    ).toEqual({
      memory_mode: "inject",
      memory_project_id: "project-a",
      memory_thread_source: "auto",
    });
    expect(
      toMemorySettingsRequest({
        enabled: false,
        activeMode: "observe",
        projectName: "   ",
        threadSource: "header",
      }),
    ).toEqual({
      memory_mode: "off",
      memory_project_id: null,
      memory_thread_source: "header",
    });
  });
});
