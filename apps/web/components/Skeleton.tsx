/**
 * The page before its data.
 *
 * These are server components with no state and no effects on purpose: they are
 * what Next streams while an async boundary is still waiting, so they must cost
 * nothing to render and must never fetch anything themselves.
 *
 * They mirror the real layout's boxes rather than being generic grey bars. A
 * skeleton whose shape does not match what replaces it is worse than no
 * skeleton: the page jumps at the moment the reader has started reading it.
 */

/** One shimmering block. `w` and `h` are CSS lengths. */
export function Bar({ w, h = 12, mt = 0 }: { w: string; h?: number; mt?: number }) {
  return <span className="sk-bar" style={{ width: w, height: h, marginTop: mt }} />;
}

/** The left rail, as geometry — no account fetch, no app list, no behaviour. */
export function RailSkeleton() {
  return (
    <aside className="sidebar">
      <div className="side-brand"><span className="logo" />Supersonic</div>
      <nav className="side-nav">
        <div className="side-label">Fleet</div>
        <div className="side-nav-item"><Bar w="62%" h={13} /></div>
        <div className="side-nav-item"><Bar w="54%" h={13} /></div>
        <div className="side-label">Manage</div>
        <div className="side-nav-item"><Bar w="48%" h={13} /></div>
        <div className="side-nav-item"><Bar w="34%" h={13} /></div>
      </nav>
      <div className="side-spacer" />
      <div className="side-acct">
        <div className="side-acct-id">
          <span className="acct-av sk-bar" />
          <div className="acct-idtxt"><Bar w="70%" h={12} /><Bar w="90%" h={10} mt={6} /></div>
        </div>
      </div>
    </aside>
  );
}

/** The app list: the same band, at the same height, in the same column. */
export function CardsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <>
      <section className="home-hero"><div className="hero-row"><h1>Your apps</h1></div></section>
      <div className="shelf" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          <article className="shelf-row sk" key={i}>
            <div className="shelf-preview"><div className="thumb sk-bar" /></div>
            <div className="shelf-main">
              <div className="shelf-head"><Bar w="120px" h={17} /><Bar w="60px" h={11} /></div>
              <Bar w="180px" h={12} mt={8} />
              <div className="shelf-when"><Bar w="240px" h={11} /></div>
              <div className="shelf-actions"><Bar w="330px" h={34} /></div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

/** An app's own page: the bar, the hero block and the panel below it. */
export function CockpitSkeleton() {
  return (
    <div className="main">
      <header className="topbar"><Bar w="180px" h={14} /></header>
      <div className="content">
        <div className="wrap" style={{ padding: "26px 30px" }}>
          <Bar w="220px" h={26} />
          <Bar w="320px" h={13} mt={12} />
          <div className="sk-panel"><Bar w="100%" h={132} /></div>
          <div className="sk-panel"><Bar w="100%" h={92} /></div>
        </div>
      </div>
    </div>
  );
}
