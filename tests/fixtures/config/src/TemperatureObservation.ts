// One of four classes that differ only in the constants they carry. The shape
// matches at L1 -- identifiers renamed, literal values dropped -- so the
// finding's job is to say WHICH constants parameterize it.
import { Observation, type Reading } from "./base.js";

export class TemperatureObservation extends Observation {
  static readonly loincCode = "8310-5";
  static readonly loincDisplay = "Body temperature";
  static readonly unit = "Cel";
  static readonly junctionKey = "temp";

  static build(reading: Reading): TemperatureObservation {
    const rounded = Math.round(reading.value * 100) / 100;
    return new TemperatureObservation({ value: rounded, recordedAt: reading.recordedAt });
  }

  describe(): string {
    return `${TemperatureObservation.loincDisplay}: ${this.reading.value} ${TemperatureObservation.unit}`;
  }
}
