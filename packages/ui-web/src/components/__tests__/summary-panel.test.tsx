/**
 * The summary panel's behaviour, from a reader's side (F§9, F§10.1): each of the four states it can be in, the
 * mode switch, and the two actions. Every control is found the way a screen reader finds it — by its accessible
 * name — and the assertion is always what the panel emitted, or what it refused to offer.
 */

import type { AnySummaryResult, SummaryMode } from "@lectern/api-contract";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SummaryPanel, type SummaryPanelProps } from "../SummaryPanel";

/** A finished brief result, as F§9's own shape carries one. */
const RESULT: AnySummaryResult = {
  summary: "The harbour wakes before the town does, and the quay is quiet until the first cart arrives.",
  keyTakeaways: ["The quay is quiet at first light.", "The gulls are early risers.", "The water is still."],
  model: "lectern-mock-model",
  promptVersion: "1",
  createdAt: 1_700_000_000_000,
};

/** What a case watches the panel emit. */
interface Emitted {
  modes: SummaryMode[];
  generates: number;
  listens: number;
}

/** Render the panel in a state, with every callback collected. */
function renderPanel(overrides: Partial<SummaryPanelProps> = {}): Emitted {
  const emitted: Emitted = { modes: [], generates: 0, listens: 0 };
  render(
    <SummaryPanel
      error={null}
      mode="brief"
      onGenerate={() => {
        emitted.generates += 1;
      }}
      onListen={() => {
        emitted.listens += 1;
      }}
      onModeChange={(mode) => emitted.modes.push(mode)}
      result={null}
      status="none"
      {...overrides}
    />,
  );
  return emitted;
}

/** A button by its accessible name, which is how every control here is found. */
function button(name: string): HTMLButtonElement {
  const found = screen.getByRole("button", { name });
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
  return found;
}

afterEach(cleanup);

describe("SummaryPanel states", () => {
  it("offers to make a summary before one exists", () => {
    renderPanel();
    expect(screen.getByText("No summary has been made yet.")).toBeTruthy();
    expect(button("Generate summary").disabled).toBe(false);
    expect(button("Listen").disabled).toBe(true);
  });

  it("says a job is running, and refuses a second ask while it is", () => {
    renderPanel({ status: "running" });
    expect(screen.getByRole("status").textContent).toBe("Summarizing this document…");
    expect(button("Generate summary").disabled).toBe(true);
    expect(button("Listen").disabled).toBe(true);
  });

  it("draws the summary, its takeaways and the model once the job is done", () => {
    renderPanel({ result: RESULT, status: "done" });
    expect(screen.getByText(RESULT.summary)).toBeTruthy();
    expect(screen.getByText(RESULT.model)).toBeTruthy();
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(RESULT.keyTakeaways);
    expect(button("Listen").disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws the failure with a retry", () => {
    renderPanel({ error: { code: "AI_DISABLED", message: "This hub has no LLM endpoint configured." }, status: "error" });
    expect(screen.getByRole("alert").textContent).toBe("This hub has no LLM endpoint configured.");
    expect(button("Retry").disabled).toBe(false);
    expect(button("Listen").disabled).toBe(true);
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("SummaryPanel actions", () => {
  it("emits the mode a reader picked, and shows which one is on", () => {
    const emitted = renderPanel();
    expect(button("Brief").getAttribute("aria-pressed")).toBe("true");
    expect(button("Detailed").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button("Detailed"));
    expect(emitted.modes).toEqual(["detailed"]);
  });

  it("shows the other mode as the one that is on when it is", () => {
    renderPanel({ mode: "detailed" });
    expect(button("Detailed").getAttribute("aria-pressed")).toBe("true");
    expect(button("Brief").getAttribute("aria-pressed")).toBe("false");
  });

  it("emits the two actions a finished summary offers", () => {
    const emitted = renderPanel({ result: RESULT, status: "done" });
    fireEvent.click(button("Generate summary"));
    fireEvent.click(button("Listen"));
    expect(emitted.generates).toBe(1);
    expect(emitted.listens).toBe(1);
  });

  it("emits the retry a failure offers", () => {
    const emitted = renderPanel({ error: { code: "LLM_UNAVAILABLE", message: "The endpoint could not be reached." }, status: "error" });
    fireEvent.click(button("Retry"));
    expect(emitted.generates).toBe(1);
  });
});
