import { Reading, Spec } from "../base.js";

export class WeightSpec extends Spec {
  static readonly loincCode = "29463-7";
  static readonly unit = "kg";
  static readonly display = "Body weight";

  static build(reading: Reading): WeightSpec {
    const rounded = Math.round(reading.value * 100) / 100;
    return new WeightSpec({ value: rounded, at: reading.at });
  }

  describe(): string {
    return `${WeightSpec.display}: ${this.reading.value} ${WeightSpec.unit}`;
  }
}
