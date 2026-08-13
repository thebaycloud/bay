import { Pool } from "pg";
async function main() {
  const p = new Pool({ host: "127.0.0.1", port: 5433, user: "postgres", password: process.env.PG_PASSWORD, database: "supersonic_platform", max: 1 });
  const n = await p.query(`select name, agent_version, extract(epoch from (now()-last_seen))::int ago from fleet_nodes order by name`);
  for (const x of n.rows) console.log(x.name, "| версия:", x.agent_version, "| молчит, с:", x.ago, "с");
  const r = await p.query(`select node, count(*)::int n from fleet_placements group by 1 order by 1`);
  for (const x of r.rows) console.log(x.node, "| приложений:", x.n);
  await p.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
