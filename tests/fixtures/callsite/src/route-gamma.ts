import { getMatterForAuth } from "./auth.js";

export async function loadGamma(ctx: string, matterId: string, user: { id: string; role: string }) {
  const matter = await getMatterForAuth({
    ctx,
    matterId,
    userId: user.id,
    userRole: user.role,
  });
  if (matter.owner === user.id) {
    return matter.owner;
  }
  return null;
}
