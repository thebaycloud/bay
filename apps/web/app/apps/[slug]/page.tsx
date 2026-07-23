import { Cockpit } from "@/components/Cockpit";
import { describeService, type ServiceInfo } from "@/lib/gcloud";

export const dynamic = "force-dynamic";

export default async function AppPage({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  let data: ServiceInfo | null = null;
  try { data = await describeService(slug); } catch { data = null; }
  return <Cockpit appName={slug} data={data} />;
}
