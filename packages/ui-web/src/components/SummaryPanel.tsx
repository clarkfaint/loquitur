/**
 * The summary panel (F§9, F§10.1): one document's summary, and the three things a reader can do with it.
 *
 * The panel owns no state, exactly as the player bar does not: the state of the job, the result it produced and
 * the failure it ended with all arrive as props, and every user action leaves as a callback. That is what lets
 * the same panel serve the web app, the extension's panel and the desktop window, and it is what makes each of
 * the four states — nothing asked for yet, running, finished, failed — a thing a test can render on its own.
 *
 * F§9's own shapes are used rather than re-declared: `status` is a member of the hub's status set, `result` is
 * one of the two modes' results, and `error` is F§9's error object with its own code set. The mode switch is
 * drawn because `brief` and `detailed` are different jobs on the hub — switching it changes what is asked for,
 * never what is already held.
 */

import type { AnySummaryResult, SummaryError, SummaryMode, SummaryStatus } from "@lectern/api-contract";
import type { ReactElement } from "react";

/** The four states a summary can be in (F§9): no job, a job, a result, a failure. */
export type SummaryState = SummaryStatus["status"];

export interface SummaryPanelProps {
  /** What the hub says about this document and mode (F§9). */
  status: SummaryState;
  /** The result once the job is done, or `null` while it is not. */
  result: AnySummaryResult | null;
  /** The failure once the job has one, or `null` while it does not. */
  error: SummaryError | null;
  /** F§9's mode the reader has chosen: `brief` or `detailed`. */
  mode: SummaryMode;
  /** A reader picked the other length. */
  onModeChange: (mode: SummaryMode) => void;
  /** A reader asked for the summary: the first time, or again after a failure. */
  onGenerate: () => void;
  /** A reader asked to hear it read (F§9's "listen to the summary"). */
  onListen: () => void;
}

export function SummaryPanel({ status, result, error, mode, onModeChange, onGenerate, onListen }: SummaryPanelProps): ReactElement {
  const busy = status === "running";

  return (
    <section className="lectern-summary" data-summary-state={status}>
      <header className="lectern-summary__head">
        <h2 className="lectern-summary__title">Summary</h2>
        <fieldset aria-label="Summary length" className="lectern-summary__modes">
          <button aria-pressed={mode === "brief"} className="lectern-summary__mode" onClick={() => onModeChange("brief")} type="button">
            Brief
          </button>
          <button
            aria-pressed={mode === "detailed"}
            className="lectern-summary__mode"
            onClick={() => onModeChange("detailed")}
            type="button"
          >
            Detailed
          </button>
        </fieldset>
      </header>

      {status === "none" ? (
        <p className="lectern-summary__empty" role="status">
          No summary has been made yet.
        </p>
      ) : null}

      {busy ? (
        <p className="lectern-summary__running" role="status">
          Summarizing this document…
        </p>
      ) : null}

      {status === "error" && error !== null ? (
        <p className="lectern-summary__problem" role="alert">
          {error.message}
        </p>
      ) : null}

      {status === "done" && result !== null ? (
        <>
          <p className="lectern-summary__text" data-summary-text={result.summary}>
            {result.summary}
          </p>
          <ol className="lectern-summary__takeaways">
            {result.keyTakeaways.map((takeaway) => (
              <li className="lectern-summary__takeaway" data-takeaway={takeaway} key={takeaway}>
                {takeaway}
              </li>
            ))}
          </ol>
          <p className="lectern-summary__model" data-summary-model={result.model}>
            {result.model}
          </p>
        </>
      ) : null}

      <div className="lectern-summary__actions">
        <button className="lectern-summary__generate" disabled={busy} onClick={onGenerate} type="button">
          {status === "error" ? "Retry" : "Generate summary"}
        </button>
        <button className="lectern-summary__listen" disabled={status !== "done"} onClick={onListen} type="button">
          Listen
        </button>
      </div>
    </section>
  );
}
