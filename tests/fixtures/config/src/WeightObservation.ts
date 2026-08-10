// One of four classes that differ only in the constants they carry. The shape
// matches at L1 -- identifiers renamed, literal values dropped -- so the
// finding's job is to say WHICH constants parameterize it.
import { Observation, type Reading } from "./base.js";

export class WeightObservation extends Observation {
  static readonly loincCode = "29463-7";
  static readonly loincDisplay = "Body weight";
  static readonly unit = "kg";
  static readonly junctionKey = "weight";

  static build(reading: Reading): WeightObservation {
    const rounded = Math.round(reading.value * 100) / 100;
    return new WeightObservation({ value: rounded, recordedAt: reading.recordedAt });
  }

  describe(): string {
    return `${WeightObservation.loincDisplay}: ${this.reading.value} ${WeightObservation.unit}`;
  }
}
