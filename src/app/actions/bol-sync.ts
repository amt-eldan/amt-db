"use server";

import { syncBolFromMail, type BolSyncOutcome } from "@/lib/bol-sync";
import { requireSession } from "@/lib/require-session";

/**
 * The "סנכרון שטרי מטען" button on the open-orders screen.
 *
 * A thin door: authenticate, run, hand back the summary. Every rule about what
 * may be written lives in lib/bol-sync and lib/bol-write, so this path and the
 * tracking agent's cannot drift apart.
 *
 * Revalidation happens inside writeBolMatches, and only when something was
 * actually written — a run that found nothing must not blow the cache for every
 * page in the app.
 */
export async function syncBolAction(): Promise<BolSyncOutcome> {
  await requireSession();
  try {
    return await syncBolFromMail();
  } catch (error) {
    // An unexpected failure still has to reach the person watching the spinner.
    // The message is logged in full and summarized to the screen: a stack trace
    // from Gmail or Neon is not something to render into a dialog.
    console.error("bol sync failed", error);
    return { ok: false, error: "הסנכרון נכשל. הפרטים נרשמו בלוג השרת." };
  }
}
