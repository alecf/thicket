import { getMatterForAuth } from "./auth.js";

export async function loadEta(ctx: string, matterId: string, user: { id: string; role: string }) {
  try {
    const matter = await getMatterForAuth({
      ctx,
      matterId,
      userId: user.id,
      userRole: user.role,
    });
    return [matter.id, matter.owner].join(":");
  } catch {
    return undefined;
  }
}
