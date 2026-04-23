export interface Order {
  id: string;
  old_total: number; // stale — should be total_amount
}
