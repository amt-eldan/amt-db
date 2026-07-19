"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarRange, ClipboardList, Inbox, LogOut } from "lucide-react";
import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "הזמנות פתוחות", icon: ClipboardList },
  { href: "/intake", label: "קליטת הזמנה", icon: Inbox },
  { href: "/monthly", label: "סיכום חודשי", icon: CalendarRange },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="border-b md:border-b-0 md:border-e bg-muted/40 md:w-56 md:min-h-full shrink-0">
      <div className="flex md:flex-col items-center md:items-stretch gap-1 p-2 md:p-4 md:h-full">
        <div className="hidden md:block px-2 pb-4">
          <p className="text-lg font-bold">AMT</p>
          <p className="text-xs text-muted-foreground">מעקב הזמנות</p>
        </div>
        <nav className="flex md:flex-col gap-1 flex-1 overflow-x-auto">
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
                pathname === href
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-foreground/80",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <form action={logout} className="md:mt-auto">
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="text-muted-foreground w-full justify-start gap-2"
          >
            <LogOut className="size-4" />
            <span className="hidden md:inline">יציאה</span>
          </Button>
        </form>
      </div>
    </aside>
  );
}
