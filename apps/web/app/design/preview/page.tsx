"use client";
// ВРЕМЕННО — снести после снимка.
import { useEffect } from "react";
import { Cell, Chips, StatusChip } from "@/components/panel/atoms";

const TABLES = [
  { name: "orders", columns: 7, rows: 128, rowsExact: true, last: "4 minutes ago" },
  { name: "users", columns: 5, rows: 1243, rowsExact: true, last: "2 hours ago" },
  { name: "sessions", columns: 4, rows: 0, rowsExact: true, last: null },
  { name: "audit_log", columns: 6, rows: 84210, rowsExact: false, last: "just now" },
];

export default function Preview() {
  useEffect(() => { document.title = "preview"; }, []);
  return (
    <div className="fixed inset-0 overflow-auto bg-background p-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="text-val text-ink">Data</div>
        <div className="grid grid-cols-2 gap-3">
          {TABLES.map((t) => (
            <Cell key={t.name} onOpen={() => {}} sub={t.last ? `last ${t.last}` : `${t.columns} columns`} title={t.name}>
              <Chips>
                <StatusChip
                  text={`${t.rowsExact ? "" : "~"}${t.rows.toLocaleString()} ${t.rows === 1 && t.rowsExact ? "row" : "rows"}`}
                  tone={t.rows > 0 ? "green" : "grey"}
                />
              </Chips>
            </Cell>
          ))}
        </div>
      </div>
    </div>
  );
}
