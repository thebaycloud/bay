"use client";

import { useEffect, useState } from "react";
import { Clock, Play, Trash2, Plus } from "lucide-react";

interface Job { id: string; label: string; schedule: string; uri: string; state: string; lastAttempt: string; }

export function JobsPanel({ slug }: { slug: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [path, setPath] = useState("/cron");

  function load() {
    fetch(`/api/apps/${slug}/jobs`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); setJobs(d.jobs || []); })
      .catch((e) => { setErr(String(e)); setJobs([]); });
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function add() {
    if (!schedule.trim()) return;
    setErr("");
    const r = await (await fetch(`/api/apps/${slug}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name || "job", schedule, path }) })).json();
    if (r.error) { setErr(r.error); return; }
    setAdding(false); setName(""); load();
  }
  async function run(id: string) { await fetch(`/api/apps/${slug}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: id }) }); }
  async function del(id: string) { await fetch(`/api/apps/${slug}/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" }); load(); }

  return (
    <section className="section reveal" style={{ animationDelay: ".12s" }}>
      <div className="section-head">
        <span className="idx">04</span>
        <h2>Jobs</h2>
        <span className="note">scheduled tasks · Cloud Scheduler</span>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setAdding((a) => !a)}><Plus size={12} />Schedule</button>
      </div>
      {adding && (
        <div className="job-form">
          <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 120 }} />
          <input placeholder="cron — e.g. 0 9 * * *" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
          <input placeholder="/path" value={path} onChange={(e) => setPath(e.target.value)} style={{ maxWidth: 130 }} />
          <button className="btn primary sm" onClick={add}>Create</button>
        </div>
      )}
      <div className="joblist">
        {jobs === null && !err && <div className="db-empty">loading…</div>}
        {err && <div className="db-empty">⚠ {err.slice(0, 110)}</div>}
        {jobs && jobs.length === 0 && !err && <div className="db-empty">no scheduled jobs — click Schedule to add one (POSTs to your app on a cron)</div>}
        {jobs?.map((j) => (
          <div className="job-row" key={j.id}>
            <Clock size={13} />
            <span className="jn">{j.label}</span>
            <span className="jsch">{j.schedule}</span>
            <span className="juri">{j.uri.replace(/^https?:\/\//, "")}</span>
            <button className="ib" title="Run now" onClick={() => run(j.id)}><Play size={12} /></button>
            <button className="ib" title="Delete" onClick={() => del(j.id)}><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
