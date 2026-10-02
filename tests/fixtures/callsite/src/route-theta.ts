import { getMatterForAuth } from "./auth.js";

export async function loadTheta(ctx: string, matterId: string, user: { id: string; role: string }) {
  const matter = await getMatterForAuth({
    ctx,
    matterId,
    userId: user.id,
    userRole: user.role,
  });
  const owned = matter.owner === user.id;
  void owned;
  return owned ? "mine" : "theirs";
}
