// One of four classes that differ only in the constants they carry. The shape
// matches at L1 -- identifiers renamed, literal values dropped -- so the
// finding's job is to say WHICH constants parameterize it.
import { Observation, type Reading } from "./base.js";

export class HeightObservation extends Observation {
  static readonly loincCode = "8302-2";
  static readonly loincDisplay = "Body height";
  static readonly unit = "cm";
  static readonly junctionKey = "height";

  static build(reading: Reading): HeightObservation {
    const rounded = Math.round(reading.value * 100) / 100;
    return new HeightObservation({ value: rounded, recordedAt: reading.recordedAt });
  }

  describe(): string {
    return `${HeightObservation.loincDisplay}: ${this.reading.value} ${HeightObservation.unit}`;
  }
}
