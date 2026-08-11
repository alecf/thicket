import { Reading, Spec } from "../base.js";

export class HeightSpec extends Spec {
  static readonly loincCode = "8302-2";
  static readonly unit = "cm";
  static readonly display = "Body height";

  static build(reading: Reading): HeightSpec {
    const rounded = Math.round(reading.value * 100) / 100;
    return new HeightSpec({ value: rounded, at: reading.at });
  }

  describe(): string {
    return `${HeightSpec.display}: ${this.reading.value} ${HeightSpec.unit}`;
  }
}
