export interface Reading {
  value: number;
  at: string;
}

export class Spec {
  constructor(readonly reading: Reading) {}
}
