import { parseNumeric } from "./numeric";

export interface ProfitInput {
  qty: string | number | null;
  unitPrice: string | number | null;
  buyPrice: string | number | null;
  shippingCost: string | number | null;
}

/** Line sale value = qty * unit_price */
export function lineValue(line: Pick<ProfitInput, "qty" | "unitPrice">): number | null {
  const qty = parseNumeric(line.qty);
  const price = parseNumeric(line.unitPrice);
  if (qty === null || price === null) return null;
  return qty * price;
}

/**
 * Profit = (sale - buy) * qty - shipping.
 * Missing buy price → null ("ממתין"), excluded from totals.
 */
export function lineProfit(line: ProfitInput): number | null {
  const qty = parseNumeric(line.qty);
  const sale = parseNumeric(line.unitPrice);
  const buy = parseNumeric(line.buyPrice);
  if (qty === null || sale === null || buy === null) return null;
  const shipping = parseNumeric(line.shippingCost) ?? 0;
  return (sale - buy) * qty - shipping;
}
