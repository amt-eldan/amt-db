"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailSearch } from "lucide-react";
import { toast } from "sonner";
import { syncBolAction } from "@/app/actions/bol-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BolSyncSummary } from "@/lib/bol-sync";

/**
 * Asks the mailbox, now, whether a tracking number arrived for any open line that
 * still has none.
 *
 * The result always gets a dialog rather than a toast, even when nothing was
 * written — which is the common case once the mailbox is caught up. "Nothing was
 * written" and "the run could not read the mailbox" look identical from a toast,
 * and the difference is the whole point: one is fine and one needs someone to fix
 * a credential. So the run reports what it read, what it wrote, and what it is
 * handing back for a human to decide.
 */
export function BolSyncButton({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<BolSyncSummary | null>(null);

  function run() {
    startTransition(async () => {
      const result = await syncBolAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setSummary(result);
      if (result.written > 0) {
        toast.success(
          result.written === 1 ? "נוסף שטר מטען אחד" : `נוספו ${result.written} שטרי מטען`,
        );
        // The rows on screen were rendered before the write; without this the
        // dialog reports numbers the table behind it does not show yet.
        router.refresh();
      }
    });
  }

  if (!configured) {
    return (
      <Button variant="outline" size="sm" disabled title="הגישה לתיבת המייל לא מוגדרת בשרת">
        <MailSearch className="size-4" />
        סנכרון שטרי מטען
      </Button>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={run} disabled={pending}>
        <MailSearch className="size-4" />
        {pending ? "סורק את התיבה..." : "סנכרון שטרי מטען"}
      </Button>

      <Dialog open={summary !== null} onOpenChange={(open) => !open && setSummary(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>סנכרון שטרי מטען</DialogTitle>
            <DialogDescription>{summary && describe(summary)}</DialogDescription>
          </DialogHeader>

          {summary && summary.review.length > 0 && (
            <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
              <p className="text-sm font-medium">דורש בדיקה ידנית</p>
              {summary.review.map((item) => (
                <div
                  key={`${item.lineId}-${item.bol}`}
                  className="rounded-md border p-2 text-sm flex flex-col gap-1"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{item.orderNumber}</span>
                    <span className="text-muted-foreground">{item.customer}</span>
                    {item.carrier && <Badge variant="secondary">{item.carrier}</Badge>}
                    <Badge variant="outline">
                      ודאות <bdi dir="ltr">{item.confidence.toFixed(2)}</bdi>
                    </Badge>
                  </div>
                  <p className="text-muted-foreground" dir="rtl">
                    נמצא <bdi dir="ltr">{item.bol}</bdi>
                    {item.poNumber && (
                      <>
                        {" · הזמנת רכש "}
                        <bdi dir="ltr">{item.poNumber}</bdi>
                      </>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{item.reason}</p>
                </div>
              ))}
            </div>
          )}

          {summary?.truncated && (
            <p className="text-xs text-muted-foreground">
              הריצה נעצרה כשנגמר לה הזמן ולא כיסתה את כל השורות. אפשר ללחוץ שוב — מה שנכתב כבר לא
              יסרק מחדש.
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSummary(null)}>
              סגור
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The run in one sentence. It leads with what changed, then what was looked at —
 * a run that wrote nothing is normal, and saying how much mail was read is what
 * makes that believable rather than suspicious.
 */
function describe(summary: BolSyncSummary): string {
  if (summary.worklist === 0) return "כל השורות הפתוחות כבר מכילות שטר מטען.";

  const parts = [
    summary.written > 0 ? `נכתבו ${summary.written} שטרי מטען` : "לא נכתב אף שטר מטען",
    `${summary.worklist} שורות בלי שטר מטען`,
    `${summary.mailsRead} מיילים נקראו`,
  ];
  if (summary.review.length > 0) parts.push(`${summary.review.length} דורשים בדיקה`);
  return `${parts.join(" · ")}.`;
}
