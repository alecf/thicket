import { getMatterForAuth } from "./auth.js";

export async function loadAlpha(ctx: string, matterId: string, user: { id: string; role: string }) {
  const matter = await getMatterForAuth({
    ctx,
    matterId,
    userId: user.id,
    userRole: user.role,
  });
  return { alpha: matter.id };
}
