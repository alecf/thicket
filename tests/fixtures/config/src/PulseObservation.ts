// One of four classes that differ only in the constants they carry. The shape
// matches at L1 -- identifiers renamed, literal values dropped -- so the
// finding's job is to say WHICH constants parameterize it.
import { Observation, type Reading } from "./base.js";

export class PulseObservation extends Observation {
  static readonly loincCode = "8867-4";
  static readonly loincDisplay = "Heart rate";
  static readonly unit = "beats/min";
  static readonly junctionKey = "pulse";

  static build(reading: Reading): PulseObservation {
    const rounded = Math.round(reading.value * 100) / 100;
    return new PulseObservation({ value: rounded, recordedAt: reading.recordedAt });
  }

  describe(): string {
    return `${PulseObservation.loincDisplay}: ${this.reading.value} ${PulseObservation.unit}`;
  }
}
