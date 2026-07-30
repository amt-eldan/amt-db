"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, Loader2Icon, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type FileStatus = "pending" | "extracting" | "success" | "failed";

interface FileProgress {
  name: string;
  status: FileStatus;
  error?: string;
}

const STATUS_LABELS: Record<FileStatus, string> = {
  pending: "ממתין",
  extracting: "מחלץ",
  success: "הצליח",
  failed: "נכשל",
};

export function UploadOrderButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<FileProgress[]>([]);

  function setStatus(index: number, status: FileStatus, error?: string) {
    setProgress((prev) => prev.map((p, i) => (i === index ? { ...p, status, error } : p)));
  }

  async function uploadOne(file: File): Promise<{ ok: boolean; error?: string }> {
    const body = new FormData();
    body.append("file", file);

    let res: Response;
    try {
      res = await fetch("/api/upload-order", { method: "POST", body });
    } catch {
      return { ok: false, error: "שליחת הקובץ נכשלה — בדוק את החיבור לרשת" };
    }

    // The proxy redirects an expired session to the /login HTML page, so the
    // body is not always JSON.
    let data: {
      error?: string;
      orderNumber?: string;
      customer?: string;
      lineCount?: number;
      warnings?: string[];
    } | null = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        error:
          data?.error ??
          (res.status === 401 || res.redirected
            ? "פג תוקף ההתחברות — יש להתחבר מחדש"
            : `החילוץ נכשל (${res.status})`),
      };
    }

    toast.success(
      `${data?.orderNumber ?? file.name} · ${data?.customer ?? ""} — ${data?.lineCount ?? 0} שורות נקלטו לאישור`,
    );
    for (const warning of data?.warnings ?? []) toast.warning(warning);
    router.refresh();
    return { ok: true };
  }

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    setUploading(true);
    setProgress(files.map((f) => ({ name: f.name, status: "pending" as const })));

    // Serial on purpose: extraction takes 10–40s per file, and running them in
    // parallel would push the function past its timeout.
    for (const [index, file] of files.entries()) {
      setStatus(index, "extracting");
      const result = await uploadOne(file);
      if (result.ok) {
        setStatus(index, "success");
      } else {
        // A failed file must not stop the rest; the row stays on screen so the
        // user can retry it.
        setStatus(index, "failed", result.error);
        toast.error(`${file.name}: ${result.error}`);
      }
    }

    setUploading(false);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    void handleFiles(e.dataTransfer.files);
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border"
        } ${uploading ? "opacity-60" : ""}`}
      >
        <FileText className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          גרור לכאן קובץ PDF של הזמנה, או בחר קובץ. החילוץ נעשה על ידי Claude וממתין לאישורך.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? <Loader2Icon className="animate-spin" /> : null}
          {uploading ? "מעלה..." : "העלאת הזמנה"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {progress.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          {progress.map((p, i) => (
            <div key={`${p.name}-${i}`} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm">
                {p.status === "extracting" && (
                  <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                )}
                {p.status === "success" && <Check className="size-4 text-emerald-600" />}
                {p.status === "failed" && <X className="size-4 text-destructive" />}
                {p.status === "pending" && <FileText className="size-4 text-muted-foreground" />}
                <bdi dir="ltr" className="truncate">
                  {p.name}
                </bdi>
                <span className="text-xs text-muted-foreground">{STATUS_LABELS[p.status]}</span>
              </div>
              {p.status === "extracting" && (
                <>
                  <Skeleton className="h-4 w-full" />
                  <p className="text-xs text-muted-foreground">מחלץ נתונים מההזמנה...</p>
                </>
              )}
              {p.status === "failed" && p.error && (
                <p className="text-xs text-destructive">{p.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
