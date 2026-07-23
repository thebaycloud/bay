import { auth } from "@/auth";

export async function currentUserId(): Promise<string | null> {
  const s = await auth();
  return (s?.user as { id?: string } | undefined)?.id ?? null;
}
