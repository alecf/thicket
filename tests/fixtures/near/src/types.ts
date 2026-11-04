export interface Order {
  customer: string;
  region: string;
  amount: number;
  quantity: number;
}

export interface Summary {
  region: string;
  count: number;
  total: number;
  top: { customer: string; amount: number }[];
  average: number;
}
