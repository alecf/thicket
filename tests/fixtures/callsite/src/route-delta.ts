import { getMatterForAuth } from "./auth.js";

export async function loadDelta(ctx: string, matterId: string, user: { id: string; role: string }) {
  const tally = new Map<string, number>();
  const matter = await getMatterForAuth({
    ctx,
    matterId,
    userId: user.id,
    userRole: user.role,
  });
  tally.set(matter.id, 1);
  tally.set(matter.owner, 2);
  return tally;
}
