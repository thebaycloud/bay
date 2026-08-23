"use client";

import { useEffect, useState } from "react";
import { Clock, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, RowList } from "@/components/panel/atoms";

interface Job {
  id: string;
  label: string;
  schedule: string;
  uri: string;
  state: string;
  lastAttempt: string;
}

/**
 * What runs on its own.
 *
 * Rebuilt on the panel's rows — it was `section reveal` / `job-row` / `btn sm`,
 * classes from the injected drawer's stylesheet that this app does not load, so
 * the numbered heading and every control rendered unstyled.
 *
 * The form is a row of the list rather than a block above it, because a job
 * being written belongs among the jobs.
 */
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
      .then((d) => {
        if (d.error) setErr(d.error);
        setJobs(d.jobs || []);
      })
      .catch((e) => {
        setErr(String(e));
        setJobs([]);
      });
  }
  useEffect(() => {
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  async function add() {
    if (!schedule.trim()) return;
    setErr("");
    const r = await (
      await fetch(`/api/apps/${slug}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || "job", schedule, path }),
      })
    ).json();
    if (r.error) {
      setErr(r.error);
      return;
    }
    setAdding(false);
    setName("");
    load();
  }
  async function run(id: string) {
    await fetch(`/api/apps/${slug}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run: id }),
    });
  }
  async function del(id: string) {
    await fetch(`/api/apps/${slug}/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3 px-0.5">
        <h2 className="text-[15px] text-ink">Jobs</h2>
        <span className="text-[13px] text-ink-3">a POST to your app, on a cron</span>
        <Button className="ml-auto" onClick={() => setAdding((a) => !a)} size="sm" variant="outline">
          <Plus className="size-3.5" />
          Schedule
        </Button>
      </div>

      <RowList>
        {adding ? (
          <form
            className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 last:border-0"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input
              className="h-9 w-[120px]"
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="name"
              value={name}
            />
            <Input
              className="h-9 min-w-[140px] flex-1"
              onChange={(e) => setSchedule(e.currentTarget.value)}
              placeholder="0 9 * * *"
              value={schedule}
            />
            <Input
              className="h-9 w-[130px]"
              onChange={(e) => setPath(e.currentTarget.value)}
              placeholder="/path"
              value={path}
            />
            <Button type="submit">Create</Button>
          </form>
        ) : null}

        {jobs === null && !err ? <Row sub="reading the schedule…" title="Jobs" /> : null}

        {err ? <Row sub={err.slice(0, 110)} title="That could not be read" /> : null}

        {jobs && jobs.length === 0 && !err ? (
          <Row sub="Schedule adds one — it POSTs to your app on a cron" title="Nothing scheduled" />
        ) : null}

        {jobs?.map((j) => (
          <Row
            icon={Clock}
            key={j.id}
            sub={
              <span>
                {j.schedule} · {j.uri.replace(/^https?:\/\//, "")}
              </span>
            }
            title={j.label}
          >
            <Button
              aria-label={`Run ${j.label} now`}
              className="size-7 text-ink-3 hover:text-ink"
              onClick={() => run(j.id)}
              size="icon-sm"
              variant="ghost"
            >
              <Play className="size-3.5" />
            </Button>
            <Button
              aria-label={`Delete ${j.label}`}
              className="size-7 text-ink-3 hover:text-ink"
              onClick={() => del(j.id)}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </Row>
        ))}
      </RowList>
    </section>
  );
}
