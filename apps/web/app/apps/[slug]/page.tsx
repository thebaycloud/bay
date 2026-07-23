import { Cockpit } from "@/components/Cockpit";
import { describeService, type ServiceInfo } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppPage({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();

  let data: ServiceInfo | null = null;
  try { data = await describeService(slug); } catch { data = null; }

  if (!data || data.owner !== uid) {
    return (
      <div className="authpage">
        <div className="authbox">
          <div className="authbrand">SUPERSONIC</div>
          <h1>Not found</h1>
          <p className="authalt">This app doesn&apos;t exist or isn&apos;t yours. <a href="/">Back to your apps</a></p>
        </div>
      </div>
    );
  }
  return <Cockpit appName={slug} data={data} />;
}
