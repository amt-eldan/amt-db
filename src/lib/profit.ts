export interface ProfitInput {
  qty: string | number | null;
  unitPrice: string | number | null;
  buyPrice: string | number | null;
  shippingCost: string | number | null;
}

function num(v: string | number | null): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isNaN(n) ? null : n;
}

/** Line sale value = qty * unit_price */
export function lineValue(line: Pick<ProfitInput, "qty" | "unitPrice">): number | null {
  const qty = num(line.qty);
  const price = num(line.unitPrice);
  if (qty === null || price === null) return null;
  return qty * price;
}

/**
 * Profit = (sale - buy) * qty - shipping.
 * Missing buy price → null ("ממתין"), excluded from totals.
 */
export function lineProfit(line: ProfitInput): number | null {
  const qty = num(line.qty);
  const sale = num(line.unitPrice);
  const buy = num(line.buyPrice);
  if (qty === null || sale === null || buy === null) return null;
  const shipping = num(line.shippingCost) ?? 0;
  return (sale - buy) * qty - shipping;
}
