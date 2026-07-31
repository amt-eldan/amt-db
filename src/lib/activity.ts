/**
 * Hebrew for an audit_log row. The log is written in code words (`courier_invoice`
 * + `approve`); the dashboard shows a sentence. Pure, so the phrasing is testable
 * and an unknown pair degrades to the raw words instead of an empty line.
 */
const ENTITY_LABELS: Record<string, string> = {
  order: "הזמנה",
  order_line: "שורת הזמנה",
  staged_order: "הזמנה סרוקה",
  supplier_invoice: "חשבונית ספק",
  courier_invoice: "חשבונית בלדר",
  staged_courier_invoice: "חשבונית בלדר ממתינה",
};

const ACTION_LABELS: Record<string, string> = {
  create: "נוספה",
  update: "עודכנה",
  delete: "נמחקה",
  approve: "אושרה",
  reject: "נדחתה",
  ingest: "נקלטה",
  close: "נסגרה",
  reopen: "נפתחה מחדש",
  set_manual_status: "שינוי סטטוס",
  reallocate: "שיוך עלות משלוח עודכן",
};

/** Where the entity lives, so an activity line is also a way back to it. */
const ENTITY_HREFS: Record<string, string> = {
  order: "/orders",
  order_line: "/orders",
  staged_order: "/intake",
  supplier_invoice: "/invoices",
  courier_invoice: "/courier",
  staged_courier_invoice: "/courier",
};

export function describeActivity(entity: string, action: string): string {
  const what = ENTITY_LABELS[entity] ?? entity;
  const did = ACTION_LABELS[action] ?? action;
  return `${what} ${did}`;
}

export function activityHref(entity: string): string | null {
  return ENTITY_HREFS[entity] ?? null;
}
