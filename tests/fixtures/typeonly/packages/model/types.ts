export interface Shape {
  kind: string;
  size: number;
}

export type Sized = Pick<Shape, "size">;

export const EMPTY: Shape = { kind: "", size: 0 };
