import { getMatterForAuth } from "./auth.js";

export async function loadBeta(ctx: string, matterId: string, user: { id: string; role: string }) {
  const seen = new Set<string>();
  const matter = await getMatterForAuth({
    ctx,
    matterId,
    userId: user.id,
    userRole: user.role,
  });
  seen.add(matter.owner);
  return [...seen];
}
