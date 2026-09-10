"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2Icon, Receipt, X } from "lucide-react";
import { toast } from "sonner";
import { applyPurchaseOrder } from "@/app/actions/purchase-order";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** One purchase-order line and the order line it would land on. */
interface Proposal {
  index: number;
  pn: string | null;
  sku: string | null;
  qty: number | null;
  unitCost: number | null;
  notes: string | null;
  lineId: number | null;
  matchedBy?: string;
  tieBrokenBy?: string;
  orderNumber?: string | null;
  customerName?: string | null;
  lineQty?: string | null;
  existingBuyPrice?: string | null;
  ok: boolean;
  reason?: string;
  warnings?: string[];
}

interface Preview {
  poNumber: string;
  supplier: string;
  orderDate: string | null;
  currency: "USD" | "ILS";
  sourceFile: string;
  warnings: string[];
  proposals: Proposal[];
  matchable: number;
}

const MONEY: Record<"USD" | "ILS", string> = { USD: "$", ILS: "₪" };

/**
 * Uploading **our** purchase order to a supplier, to get the unit buy price onto
 * the lines it belongs to.
 *
 * Separate from the customer-order upload right next to it, and labelled to say
 * so, because the two documents are mirror images: one carries what a customer
 * pays us, the other what we pay a supplier, and the extractors refuse each
 * other's documents outright. Two buttons that each name their document is the
 * only version of this screen where the distinction is visible at the moment it
 * matters — before the file is chosen.
 *
 * Nothing is written by the upload. What comes back is a proposal, shown as a
 * table of "this cost would go on that line", and applying it is a second,
 * deliberate click.
 */
export function UploadPurchaseOrderButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applying, startApply] = useTransition();

  async function upload(file: File) {
    setUploading(true);
    setPreview(null);
    const body = new FormData();
    body.append("file", file);

    let res: Response;
    try {
      res = await fetch("/api/upload-purchase-order", { method: "POST", body });
    } catch {
      setUploading(false);
      toast.error("שליחת הקובץ נכשלה — בדוק את החיבור לרשת");
      return;
    }

    // An expired session is answered with the /login HTML page, not JSON.
    let data: (Preview & { error?: string }) | null = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    setUploading(false);

    if (!res.ok || !data || data.error) {
      toast.error(
        data?.error ??
          (res.status === 401 || res.redirected
            ? "פג תוקף ההתחברות — יש להתחבר מחדש"
            : `החילוץ נכשל (${res.status})`),
      );
      return;
    }

    setPreview(data);
    if (data.matchable === 0) {
      toast.warning("לא נמצאה אף שורה שאפשר לשייך לה מחיר — ראה את הפירוט");
    }
  }

  function apply() {
    if (!preview) return;
    const matches = preview.proposals
      .filter((p) => p.ok && p.lineId !== null && p.unitCost !== null)
      .map((p) => ({ lineId: p.lineId!, unitCost: p.unitCost!, qty: p.qty }));

    startApply(async () => {
      const result = await applyPurchaseOrder({
        poNumber: preview.poNumber,
        supplier: preview.supplier,
        currency: preview.currency,
        sourceFile: preview.sourceFile,
        matches,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        result.written === 1
          ? "מחיר קנייה נשמר על שורה אחת"
          : `מחירי קנייה נשמרו על ${result.written} שורות`,
      );
      if (result.skipped > 0) {
        const reasons = result.results.filter((r) => r.status === "skipped").map((r) => r.reason);
        toast.warning(`${result.skipped} שורות דולגו: ${[...new Set(reasons)].join("; ")}`);
      }
      setPreview(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
        <Receipt className="size-5 text-muted-foreground shrink-0" />
        <p className="text-sm text-muted-foreground flex-1 min-w-48">
          <span className="font-medium text-foreground">הזמנת רכש שלנו לספק</span> — מכאן נקלט
          מחיר הקנייה ליחידה. זה לא המסך להזמנות שלקוחות שולחים אלינו.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={uploading || applying}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? <Loader2Icon className="animate-spin" /> : null}
          {uploading ? "מחלץ..." : "העלאת הזמנת רכש"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>

      {preview && (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary" dir="ltr">
              {preview.poNumber}
            </Badge>
            <span className="font-medium">{preview.supplier || "ספק לא זוהה"}</span>
            <span className="text-muted-foreground">
              {preview.currency === "USD" ? "בדולרים" : "בשקלים"}
            </span>
            {preview.orderDate && (
              <span className="text-muted-foreground" dir="ltr">
                {preview.orderDate}
              </span>
            )}
            <span className="text-muted-foreground">
              · {preview.matchable} מתוך {preview.proposals.length} שורות ישויכו
            </span>
          </div>

          {preview.warnings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {preview.warnings.map((w, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-500">
                  <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>P/N</TableHead>
                  <TableHead>כמות</TableHead>
                  <TableHead>מחיר ליח&apos;</TableHead>
                  <TableHead>ישויך לשורה</TableHead>
                  <TableHead>הערות</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.proposals.map((p) => (
                  <TableRow key={p.index} className={p.ok ? undefined : "opacity-70"}>
                    <TableCell className="text-muted-foreground">{p.index}</TableCell>
                    <TableCell dir="ltr" className="font-mono text-xs">
                      {p.pn ?? p.sku ?? "—"}
                    </TableCell>
                    <TableCell dir="ltr">{p.qty ?? "—"}</TableCell>
                    <TableCell dir="ltr" className="whitespace-nowrap">
                      {p.unitCost === null ? "—" : `${MONEY[preview.currency]}${p.unitCost}`}
                    </TableCell>
                    <TableCell>
                      {p.ok && p.lineId !== null ? (
                        <span className="flex items-center gap-1.5">
                          <Check className="size-3.5 text-emerald-600 shrink-0" />
                          <span className="text-xs">
                            <bdi dir="ltr">{p.orderNumber}</bdi>
                            {p.customerName ? ` · ${p.customerName}` : ""}
                          </span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <X className="size-3.5 text-destructive shrink-0" />
                          <span className="text-xs text-muted-foreground">לא ישויך</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-64">
                      {p.reason ?? p.warnings?.join(" · ") ?? (p.tieBrokenBy === "qty" ? "הותאם לפי כמות" : "")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={applying || preview.matchable === 0}
              onClick={apply}
            >
              {applying ? <Loader2Icon className="animate-spin" /> : null}
              שמור מחירי קנייה ({preview.matchable})
            </Button>
            <Button type="button" variant="ghost" disabled={applying} onClick={() => setPreview(null)}>
              בטל
            </Button>
          </div>

          {preview.currency === "USD" && (
            <p className="text-xs text-muted-foreground">
              המחירים נשמרים בדולרים. ההמרה לשקלים נעשית בשער היציג של בנק ישראל לתאריך המסירה —
              שורה שעוד לא נמסרה תקבל את הסכום בשקלים כשהספקית תאשר מסירה.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
