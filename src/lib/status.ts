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
 * Row status color, by priority:
 * 1. manual override: הגיע=green, סופק חלקי=orange, מאחר=red
 * 2. BOL filled → green (delivered)
 * 3. delivery_update/notes contain "סופק" but not "לא סופק" → orange (partial)
 * 4. contract due date in the past → red (late)
 * 5. otherwise neutral (on track)
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

  if (line.bol && line.bol.trim() !== "") return "green";

  const freeText = `${line.deliveryUpdate ?? ""} ${line.notes ?? ""}`;
  if (freeText.includes("סופק") && !freeText.includes("לא סופק")) return "orange";

  if (line.contractDueDate) {
    const due = new Date(line.contractDueDate + "T00:00:00");
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (due < startOfToday) return "red";
  }

  return "neutral";
}

export const STATUS_LABELS: Record<LineStatus, string> = {
  green: "הגיע / סופק",
  orange: "סופק חלקי",
  red: "מאחר",
  neutral: "במסלול",
};
