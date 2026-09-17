export interface Matter {
  id: string;
  owner: string;
}

export async function getMatterForAuth(input: {
  ctx: string;
  matterId: string;
  userId: string;
  userRole: string;
}): Promise<Matter> {
  return { id: input.matterId, owner: input.userId };
}
