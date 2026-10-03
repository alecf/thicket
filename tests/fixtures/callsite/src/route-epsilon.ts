import { getMatterForAuth } from "./auth.js";

export async function loadEpsilon(ctx: string, matterId: string, user: { id: string; role: string }) {
  const matter = await getMatterForAuth({
    ctx,
    matterId,
    userId: user.id,
    userRole: user.role,
  });
  const parts = matter.id.split("-");
  return parts.length > 1 ? parts[1] : parts[0];
}
