import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Run = { id: string; project: string; status: string; started_at: string; finished_at?: string; scenario_count: number; passed_count: number; partial_count: number; failed_count: number };
type Scenario = { id: string; name: string; status: string; duration_ms?: number; error_message?: string; assertions: Array<{ assertion_key: string; expected_json: string; actual_json: string; status: string; evidence_source: string; message?: string }>; paymentDiagnostics?: Array<{ kind: string; title: string; explanation: string; next_step: string; confidence: string; source: string; code?: string; decline_code?: string; field?: string; payment_intent_id?: string }>; stripeResources: Array<{ resource_type: string; stripe_id: string; created_by_subtest: number }>; events: Array<{ stripe_event_id: string; event_type: string; created_at: string; app_evidence_status?: string }> };
type Detail = { id: string; status: string; started_at: string; app_origin: string; stripe_account_id: string; stripe_api_version: string; scenarios: Scenario[] };

function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/v1/runs").then((response) => response.json()).then(setRuns).catch(() => setError("Could not load local run history."));
  }, []);
  async function openRun(id: string) {
    const response = await fetch("/api/v1/runs/" + encodeURIComponent(id));
    if (!response.ok) { setError("Could not open this run."); return; }
    setSelected(await response.json());
  }
  return (
    <main className="shell">
      <header><div className="eyebrow">LOCAL QA WORKSPACE</div><h1>SubTest</h1><p>Stripe subscription checks, with a clear record of what happened.</p></header>
      {error && <div className="error" role="alert">{error}</div>}
      {selected ? <section className="card">
        <button className="back" onClick={() => setSelected(null)}>← All runs</button>
        <div className="section-heading"><div><div className="eyebrow">RUN DETAIL</div><h2>{selected.status}</h2></div><span className="badge">LOCAL ONLY</span></div>
        <p>{new Date(selected.started_at).toLocaleString()} · {selected.app_origin} · Stripe test account {selected.stripe_account_id} · API {selected.stripe_api_version}</p>
        {selected.scenarios.map((scenario) => <article className="scenario" key={scenario.id}>
          <h3><span className={"dot " + scenario.status}></span>{scenario.name}</h3>
          <p>{scenario.status}{scenario.duration_ms ? " · " + (scenario.duration_ms / 1000).toFixed(1) + "s" : ""}</p>
          {scenario.error_message && <p className={scenario.status === "partial" ? "notice" : "error"}>{scenario.error_message}</p>}
          {scenario.paymentDiagnostics?.map((diagnosis, i) => <div className="diagnosis" key={i}><b>Payment diagnosis · {diagnosis.title}</b><p>{diagnosis.explanation}</p><p><b>Next step:</b> {diagnosis.next_step}</p><small>{diagnosis.source} evidence · {diagnosis.confidence} confidence{diagnosis.code ? ` · ${diagnosis.code}` : ""}{diagnosis.decline_code ? ` / ${diagnosis.decline_code}` : ""}{diagnosis.field ? ` · field ${diagnosis.field}` : ""}</small></div>)}
          {scenario.assertions.map((item, i) => <div className="assertion" key={i}><b>{item.status === "passed" ? "✓" : item.status === "skipped" ? "–" : item.status === "blocked" ? "!" : "×"} {item.assertion_key}</b><span>{item.status === "skipped" || item.status === "blocked" ? item.message : `expected ${item.expected_json}; got ${item.actual_json}`}</span><small>Evidence: {item.evidence_source}</small></div>)}
          {scenario.stripeResources?.length > 0 && <div className="events"><b>Stripe test resources</b>{scenario.stripeResources.map((item) => <span key={item.stripe_id}>{item.resource_type} · {item.stripe_id}{item.created_by_subtest ? " · created by SubTest" : " · created by app"}</span>)}</div>}
          {scenario.events.length > 0 && <div className="events"><b>Stripe events seen</b>{scenario.events.map((event) => <span key={event.stripe_event_id}>{event.event_type} · {event.stripe_event_id} · app {event.app_evidence_status ?? "not checked"}</span>)}</div>}
        </article>)}
      </section> : <section className="card">
        <div className="section-heading"><div><div className="eyebrow">RUN HISTORY</div><h2>{runs.length ? runs.length + " recent run(s)" : "No runs yet"}</h2></div><span className="badge">LOCAL ONLY</span></div>
        {runs.length ? <div className="run-list">{runs.map((run) => <button className="run-row" key={run.id} onClick={() => void openRun(run.id)}>
          <span><b>{run.project}</b><small>{new Date(run.started_at).toLocaleString()}</small></span>
          <span><i className={"dot " + run.status}></i>{run.status}</span><span>{run.passed_count ?? 0} passed · {run.partial_count ?? 0} partial · {run.failed_count ?? 0} failed</span>
        </button>)}</div> : <div className="empty-state">Run <code>subtest run</code> in your project. Completed scenarios will appear here.</div>}
      </section>}
      <footer>SubTest runs in Stripe test mode and keeps history on this machine.</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
