"use client";

import { useEffect, useState } from "react";
import { Table2, Play } from "lucide-react";

interface TableRow { name: string; columns: number; rows: number; }
interface Grid { columns: string[]; rows: Record<string, unknown>[]; }

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function DatabasePanel({ slug, hasDb }: { slug: string; hasDb: boolean }) {
  const [tables, setTables] = useState<TableRow[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [err, setErr] = useState("");
  const [sql, setSql] = useState("");

  useEffect(() => {
    if (!hasDb) return;
    fetch(`/api/apps/${slug}/db`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setErr(d.error); setTables([]); return; }
        setTables(d.tables ?? []);
        if (d.tables?.[0]) openTable(d.tables[0].name);
      })
      .catch((e) => { setErr(String(e)); setTables([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openTable(t: string) {
    setActive(t); setErr("");
    fetch(`/api/apps/${slug}/db?table=${encodeURIComponent(t)}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) { setErr(d.error); setGrid(null); } else setGrid(d); });
  }
  function runQuery() {
    if (!sql.trim()) return;
    setErr("");
    fetch(`/api/apps/${slug}/db`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) })
      .then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); else { setActive(null); setGrid(d); } });
  }

  if (!hasDb) return null;

  return (
    <section className="section reveal" style={{ animationDelay: ".09s" }}>
      <div className="section-head"><span className="idx">02</span><h2>Database</h2><span className="note">postgres · browse &amp; query</span></div>
      <div className="db">
        <div className="db-tables">
          {tables === null && !err && <div className="db-empty">loading…</div>}
          {tables?.map((t) => (
            <button key={t.name} className={"db-table" + (active === t.name ? " on" : "")} onClick={() => openTable(t.name)}>
              <Table2 size={13} /><span className="tn">{t.name}</span><span className="tc">{t.rows}</span>
            </button>
          ))}
          {tables && tables.length === 0 && !err && <div className="db-empty">no tables yet</div>}
        </div>
        <div className="db-main">
          <div className="db-query">
            <input value={sql} onChange={(e) => setSql(e.target.value)} placeholder="SELECT * FROM … (read-only)" onKeyDown={(e) => { if (e.key === "Enter") runQuery(); }} />
            <button className="btn" onClick={runQuery}><Play size={12} />Run</button>
          </div>
          {err && <div className="db-empty">⚠ {err.slice(0, 120)}</div>}
          <div className="db-grid">
            {grid ? (
              grid.rows.length === 0 ? <div className="db-empty">0 rows</div> : (
                <table className="dg">
                  <thead><tr>{grid.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{grid.rows.map((row, i) => <tr key={i}>{grid.columns.map((c) => <td key={c}>{fmt(row[c])}</td>)}</tr>)}</tbody>
                </table>
              )
            ) : (!err && <div className="db-empty">select a table</div>)}
          </div>
        </div>
      </div>
    </section>
  );
}
