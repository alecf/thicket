import { Reading, Spec } from "../base.js";

export class PulseSpec extends Spec {
  static readonly loincCode = "8867-4";
  static readonly unit = "beats/min";
  static readonly display = "Heart rate";

  static build(reading: Reading): PulseSpec {
    const rounded = Math.round(reading.value * 100) / 100;
    return new PulseSpec({ value: rounded, at: reading.at });
  }

  describe(): string {
    return `${PulseSpec.display}: ${this.reading.value} ${PulseSpec.unit}`;
  }
}
