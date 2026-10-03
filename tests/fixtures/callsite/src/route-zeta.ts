import { getMatterForAuth } from "./auth.js";

export async function loadZeta(ctx: string, matterId: string, user: { id: string; role: string }) {
  const started = ctx.length;
  const matter = await getMatterForAuth({
    ctx,
    matterId,
    userId: user.id,
    userRole: user.role,
  });
  return { zeta: matter.owner, started };
}
