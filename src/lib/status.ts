export type LineStatus = "green" | "orange" | "red" | "neutral";

export interface StatusInput {
  manualStatus: string | null;
  bol: string | null;
  deliveryUpdate: string | null;
  notes: string | null;
  contractDueDate: string | null; // ISO yyyy-mm-dd
}

export const MANUAL_STATUSES = ["הגיע", "סופק חלקי", "מאחר"] as const;

/**
 * True when the contract delivery date has already passed. Dates only — a line
 * due today is not late until tomorrow.
 */
export function isPastContractDue(
  contractDueDate: string | null,
  today: Date = new Date(),
): boolean {
  if (!contractDueDate) return false;
  const due = new Date(contractDueDate + "T00:00:00");
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return due < startOfToday;
}

/**
 * Row status color, by priority:
 * 1. manual override: הגיע=green, סופק חלקי=orange, מאחר=red
 * 2. contract due date already passed → red (late)
 * 3. BOL filled → green (shipped, still inside the contract date)
 * 4. delivery_update/notes contain "סופק" but not "לא סופק" → orange (partial)
 * 5. otherwise neutral (on track)
 *
 * The due date is checked **before** the bill of lading, and that order is the
 * whole point: red means "the contract delivery date was missed", so writing a
 * tracking number onto a line that is already overdue must not turn it green.
 * The shipment is on its way, but it is late, and a late line stays red until a
 * human says otherwise through manualStatus. Only the manual override outranks
 * the date, because that is a person stating what actually happened ("הגיע")
 * rather than the system inferring arrival from a document.
 */
export function lineStatus(line: StatusInput, today: Date = new Date()): LineStatus {
  switch (line.manualStatus) {
    case "הגיע":
      return "green";
    case "סופק חלקי":
      return "orange";
    case "מאחר":
      return "red";
  }

  if (isPastContractDue(line.contractDueDate, today)) return "red";

  if (line.bol && line.bol.trim() !== "") return "green";

  const freeText = `${line.deliveryUpdate ?? ""} ${line.notes ?? ""}`;
  if (freeText.includes("סופק") && !freeText.includes("לא סופק")) return "orange";

  return "neutral";
}

export const STATUS_LABELS: Record<LineStatus, string> = {
  green: "הגיע / סופק",
  orange: "סופק חלקי",
  red: "מאחר",
  neutral: "במסלול",
};
