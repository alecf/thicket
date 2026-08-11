import { Reading, Spec } from "../base.js";

export class BmiSpec extends Spec {
  static readonly loincCode = "39156-5";
  static readonly unit = "kg/m2";
  static readonly display = "Body mass index";

  static build(reading: Reading): BmiSpec {
    const rounded = Math.round(reading.value * 100) / 100;
    return new BmiSpec({ value: rounded, at: reading.at });
  }

  describe(): string {
    return `${BmiSpec.display}: ${this.reading.value} ${BmiSpec.unit}`;
  }
}
