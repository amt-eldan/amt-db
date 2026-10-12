"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { setMailUpdateHandled } from "@/app/actions/mail-updates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { MailUpdateRow } from "@/db/queries";
import { formatDate } from "@/lib/format";
import {
  gmailLink,
  isMailUpdateKind,
  MAIL_UPDATE_KINDS,
  MAIL_UPDATE_LABELS,
  type MailUpdateKind,
} from "@/lib/mail-updates";
import { normalizeTracking } from "@/lib/courier-match";
import { cn } from "@/lib/utils";

type KindFilter = MailUpdateKind | "all";

const KIND_STYLES: Record<MailUpdateKind, string> = {
  bol: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  delay: "bg-red-500/15 text-red-700 dark:text-red-400",
  payment_request: "bg-amber-500/15 text-amber-700 dark:text-amber-500",
};

/**
 * What suppliers wrote about our purchase orders: shipping notices, delays and
 * payment requests, as the scheduled task read them from the orders mailbox.
 *
 * The screen is a to-do list. Every row stays "לטיפול" — and counted on the
 * dashboard — until someone marks it handled; handled rows are one switch away
 * for when the history matters.
 */
export function UpdatesView({
  updates,
  initialKind,
}: {
  updates: MailUpdateRow[];
  initialKind: KindFilter;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<KindFilter>(initialKind);
  const [showHandled, setShowHandled] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  const open = useMemo(() => updates.filter((u) => u.handledAt === null), [updates]);
  const counts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: open.length, bol: 0, delay: 0, payment_request: 0 };
    for (const u of open) if (isMailUpdateKind(u.kind)) c[u.kind]++;
    return c;
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return updates.filter((u) => {
      if (!showHandled && u.handledAt !== null) return false;
      if (kind !== "all" && u.kind !== kind) return false;
      if (!q) return true;
      return [
        u.poNumber,
        u.subject,
        u.sender,
        u.quote,
        u.bol,
        u.supplier,
        ...u.lines.flatMap((l) => [l.orderNumber, l.customerName, l.pn]),
      ].some((v) => v?.toLowerCase().includes(q));
    });
  }, [updates, kind, showHandled, search]);

  function toggle(update: MailUpdateRow) {
    const handled = update.handledAt === null;
    setPendingId(update.id);
    startTransition(async () => {
      const result = await setMailUpdateHandled(update.id, handled);
      setPendingId(null);
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">עדכונים מהמייל</h1>
          <p className="text-xs text-muted-foreground">
            מה שהספקים כתבו על הזמנות הרכש — שטרי מטען, עיכובים באספקה ובקשות לתשלום. נקרא מתיבת
            ההזמנות על ידי המשימה המתוזמנת ונשאר כאן עד שמסמנים &quot;טופל&quot;.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch id="show-handled" checked={showHandled} onCheckedChange={setShowHandled} />
          <label htmlFor="show-handled" className="text-muted-foreground cursor-pointer">
            כולל שטופלו
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["all", ...MAIL_UPDATE_KINDS] as KindFilter[]).map((k) => (
          <Button
            key={k}
            type="button"
            size="sm"
            variant={kind === k ? "default" : "outline"}
            onClick={() => setKind(k)}
            className="gap-1.5"
          >
            {k === "all" ? "הכל" : MAIL_UPDATE_LABELS[k]}
            <Badge variant="secondary" className="px-1.5">
              {counts[k]}
            </Badge>
          </Button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder="חיפוש הזמנת רכש / ספק / לקוח / מס' הזמנה / נושא / שטר מטען..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ps-9"
        />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {updates.length === 0
              ? "עוד לא התקבלו עדכונים. המשימה המתוזמנת מדווחת אותם בכל הרצה דרך הכלי mail_updates_submit."
              : showHandled
                ? "אין עדכונים שמתאימים לסינון."
                : "אין עדכונים שממתינים לטיפול."}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((u) => (
            <UpdateCard
              key={u.id}
              update={u}
              busy={pendingId === u.id}
              onToggle={() => toggle(u)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UpdateCard({
  update,
  busy,
  onToggle,
}: {
  update: MailUpdateRow;
  busy: boolean;
  onToggle: () => void;
}) {
  const kind = isMailUpdateKind(update.kind) ? update.kind : null;
  const link = gmailLink(update.threadId, update.messageId);
  const handled = update.handledAt !== null;
  const openLines = update.lines.filter((l) => l.isOpen);
  // For a bill of lading: which of the order's open lines now carry it.
  const bolKey = normalizeTracking(update.bol);
  const carrying = bolKey ? openLines.filter((l) => normalizeTracking(l.bol) === bolKey).length : 0;

  return (
    <Card className={cn("py-3", handled && "opacity-60")}>
      <CardContent className="px-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {kind && (
            <Badge variant="secondary" className={KIND_STYLES[kind]}>
              {MAIL_UPDATE_LABELS[kind]}
            </Badge>
          )}
          <span className="text-sm">
            הזמנת רכש <bdi dir="ltr" className="font-medium">{update.poNumber}</bdi>
          </span>
          {update.supplier && <span className="text-sm text-muted-foreground">· {update.supplier}</span>}
          <span className="text-xs text-muted-foreground ms-auto">
            <bdi dir="ltr">{formatDate(update.receivedAt)}</bdi>
            {update.source === "sync" ? " · סנכרון" : ""}
          </span>
        </div>

        {update.subject && <p className="text-sm font-medium">{update.subject}</p>}
        {update.quote && (
          <p className="text-sm text-muted-foreground border-s-2 ps-2 whitespace-pre-line">
            {update.quote}
          </p>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {update.sender && <span>מאת: <bdi dir="ltr">{update.sender}</bdi></span>}
          {update.bol && (
            <span>
              שטר מטען: <bdi dir="ltr" className="text-foreground">{update.bol}</bdi>
              {openLines.length > 0 &&
                (carrying === openLines.length
                  ? " · נרשם על כל השורות הפתוחות"
                  : ` · נרשם על ${carrying} מתוך ${openLines.length} שורות פתוחות`)}
            </span>
          )}
          {update.newDate && (
            <span>
              מועד חדש: <bdi dir="ltr" className="text-foreground">{formatDate(update.newDate)}</bdi>
            </span>
          )}
          {update.lines.length > 0 && (
            <span>
              הזמנות:{" "}
              {[...new Set(update.lines.map((l) => `${l.orderNumber} (${l.customerName})`))].join(", ")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant={handled ? "ghost" : "outline"} className="h-7 gap-1" disabled={busy} onClick={onToggle}>
            {handled ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
            {handled ? "החזר לטיפול" : "טופל"}
          </Button>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs underline underline-offset-4 hover:text-foreground text-muted-foreground"
            >
              <ExternalLink className="size-3.5" />
              פתח ב-Gmail
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
