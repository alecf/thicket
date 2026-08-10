export interface Reading {
  value: number;
  recordedAt: string;
}

export class Observation {
  constructor(readonly reading: Reading) {}
}
