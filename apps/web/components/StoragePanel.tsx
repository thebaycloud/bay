"use client";

import { useEffect, useState } from "react";
import { File } from "lucide-react";

interface Obj { name: string; size: number; updated: string; contentType: string; }

function fmtSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

export function StoragePanel({ slug, hasStorage }: { slug: string; hasStorage: boolean }) {
  const [objects, setObjects] = useState<Obj[] | null>(null);
  const [bucket, setBucket] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!hasStorage) return;
    fetch(`/api/apps/${slug}/storage`)
      .then((r) => r.json())
      .then((d) => { setBucket(d.bucket || ""); if (d.error) setErr(d.error); setObjects(d.objects || []); })
      .catch((e) => { setErr(String(e)); setObjects([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasStorage) return null;

  return (
    <section className="section reveal" style={{ animationDelay: ".1s" }}>
      <div className="section-head">
        <span className="idx">03</span>
        <h2>Storage</h2>
        <span className="note">{bucket || "object storage"} · {objects?.length ?? 0} files</span>
      </div>
      <div className="filelist">
        {objects === null && !err && <div className="db-empty">loading…</div>}
        {err && <div className="db-empty">⚠ {err.slice(0, 110)}</div>}
        {objects && objects.length === 0 && !err && (
          <div className="db-empty">no files yet — your app can read/write this bucket via the <span className="mono">STORAGE_BUCKET</span> env var</div>
        )}
        {objects?.map((o) => (
          <div className="file-row" key={o.name}>
            <File size={13} />
            <span className="fn">{o.name}</span>
            <span className="ft">{o.contentType || "—"}</span>
            <span className="fs">{fmtSize(o.size)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
