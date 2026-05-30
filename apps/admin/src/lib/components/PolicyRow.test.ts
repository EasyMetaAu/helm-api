import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import {
  COMPLEXITY_OPTIONS,
  type Policy,
  TASK_TYPE_OPTIONS,
} from "$lib/api/policies.js";
import PolicyRow from "./PolicyRow.svelte";

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return { match: {}, use_lane: "balanced", ...overrides };
}

const LANES = ["economy", "balanced", "premium", "coding"];

describe("PolicyRow", () => {
  it("shows the priority index passed in (1-based ordering)", () => {
    render(PolicyRow, {
      policy: makePolicy(),
      index: 0,
      total: 3,
      lanes: LANES,
      onchange: vi.fn(),
      onremove: vi.fn(),
      onmove: vi.fn(),
    });
    expect(screen.getByTestId("policy-index")).toHaveTextContent("1");
  });

  it("edits match.task_type and match.complexity into the change payload", async () => {
    const onchange = vi.fn();
    render(PolicyRow, {
      policy: makePolicy(),
      index: 0,
      total: 1,
      lanes: LANES,
      onchange,
      onremove: vi.fn(),
      onmove: vi.fn(),
    });

    await fireEvent.change(screen.getByLabelText(/task type/i), {
      target: { value: "coding" },
    });
    await fireEvent.change(screen.getByLabelText(/complexity/i), {
      target: { value: "complex" },
    });

    const last = onchange.mock.calls.at(-1)?.[0] as Policy;
    expect(last.match.task_type).toBe("coding");
    expect(last.match.complexity).toBe("complex");
  });

  it("task_type / complexity dropdowns offer exactly the docs/03 + server enum sets (no free text)", () => {
    render(PolicyRow, {
      policy: makePolicy(),
      index: 0,
      total: 1,
      lanes: LANES,
      onchange: vi.fn(),
      onremove: vi.fn(),
      onmove: vi.fn(),
    });

    const taskSelect = screen.getByLabelText(/task type/i) as HTMLSelectElement;
    const taskValues = Array.from(taskSelect.options)
      .map((o) => o.value)
      .filter((v) => v !== ""); // "" = unset/any
    expect(taskValues).toEqual([...TASK_TYPE_OPTIONS]);

    const complexitySelect = screen.getByLabelText(/complexity/i) as HTMLSelectElement;
    const complexityValues = Array.from(complexitySelect.options)
      .map((o) => o.value)
      .filter((v) => v !== "");
    expect(complexityValues).toEqual([...COMPLEXITY_OPTIONS]);

    // it must be a <select>, not a free-text input
    expect(taskSelect.tagName).toBe("SELECT");
    expect(complexitySelect.tagName).toBe("SELECT");
  });

  it("action is mutually exclusive: choosing use_lane disables the max_lane select", async () => {
    const onchange = vi.fn();
    render(PolicyRow, {
      policy: makePolicy({ use_lane: "balanced", max_lane: undefined }),
      index: 0,
      total: 1,
      lanes: LANES,
      onchange,
      onremove: vi.fn(),
      onmove: vi.fn(),
    });

    // use_lane radio selected -> max_lane select disabled
    await fireEvent.click(screen.getByLabelText(/use lane/i));
    expect(screen.getByLabelText(/max lane/i)).toBeDisabled();

    // switch to max_lane -> use_lane select disabled and payload carries only max_lane
    await fireEvent.click(screen.getByLabelText(/max lane/i));
    expect(screen.getByLabelText(/use lane/i)).toBeDisabled();
    await fireEvent.change(screen.getByLabelText(/max lane/i), {
      target: { value: "premium" },
    });
    const last = onchange.mock.calls.at(-1)?.[0] as Policy;
    expect(last.max_lane).toBe("premium");
    expect(last.use_lane).toBeUndefined();
  });

  it("empty match is flagged as a catch-all (warns it swallows later rules)", () => {
    render(PolicyRow, {
      policy: makePolicy({ match: {} }),
      index: 0,
      total: 3,
      lanes: LANES,
      onchange: vi.fn(),
      onremove: vi.fn(),
      onmove: vi.fn(),
    });
    expect(screen.getByTestId("catch-all-warning")).toBeInTheDocument();
  });

  it("remove and move buttons call their callbacks", async () => {
    const onremove = vi.fn();
    const onmove = vi.fn();
    render(PolicyRow, {
      policy: makePolicy(),
      index: 1,
      total: 3,
      lanes: LANES,
      onchange: vi.fn(),
      onremove,
      onmove,
    });
    const row = screen.getByTestId("policy-row");
    await fireEvent.click(within(row).getByRole("button", { name: /move up/i }));
    expect(onmove).toHaveBeenCalledWith(1, 0);
    await fireEvent.click(within(row).getByRole("button", { name: /remove/i }));
    expect(onremove).toHaveBeenCalledWith(1);
  });
});
