"use client";

import { useEffect, useState } from "react";
import { File } from "lucide-react";
import { Row, RowGroup } from "@/components/panel/atoms";

interface Obj {
  name: string;
  size: number;
  updated: string;
  contentType: string;
}

function fmtSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

/**
 * The app's bucket, as rows.
 *
 * Was `section reveal` with an `idx` numeral and a `filelist` — class names from
 * the injected drawer's stylesheet, which this app does not load, so every row
 * rendered as unstyled text on nothing.
 */
export function StoragePanel({ slug, hasStorage }: { slug: string; hasStorage: boolean }) {
  const [objects, setObjects] = useState<Obj[] | null>(null);
  const [bucket, setBucket] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!hasStorage) return;
    fetch(`/api/apps/${slug}/storage`)
      .then((r) => r.json())
      .then((d) => {
        setBucket(d.bucket || "");
        if (d.error) setErr(d.error);
        setObjects(d.objects || []);
      })
      .catch((e) => {
        setErr(String(e));
        setObjects([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasStorage) return null;

  return (
    <RowGroup title="Storage">
      {objects === null && !err ? (
        <Row sub="reading the bucket…" title="Storage" />
      ) : null}

      {err ? <Row sub={err.slice(0, 110)} title="That could not be read" /> : null}

      {objects && objects.length === 0 && !err ? (
        <Row
          sub="your app can read and write it through the STORAGE_BUCKET env var"
          title="No files yet"
        />
      ) : null}

      {objects?.map((o) => (
        <Row
          icon={File}
          key={o.name}
          sub={o.contentType || undefined}
          title={<span className="font-mono text-[13px]">{o.name}</span>}
        >
          <span className="font-mono text-[13px] tabular-nums text-ink-2">{fmtSize(o.size)}</span>
        </Row>
      ))}

      {bucket ? (
        <Row sub={<span className="font-mono">{bucket}</span>} title="Bucket" />
      ) : null}
    </RowGroup>
  );
}
