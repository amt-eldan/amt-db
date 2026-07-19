"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card className="max-w-md mx-auto mt-12">
      <CardContent className="py-8 text-center flex flex-col gap-4">
        <p className="text-lg font-semibold">אירעה שגיאה</p>
        <p className="text-sm text-muted-foreground">
          לא הצלחנו לטעון את הנתונים. ייתכן שיש בעיה בחיבור למסד הנתונים.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground" dir="ltr">
            {error.digest}
          </p>
        )}
        <Button onClick={reset}>נסה שוב</Button>
      </CardContent>
    </Card>
  );
}
