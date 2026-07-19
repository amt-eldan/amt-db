# AMT — מערכת מעקב הזמנות

מערכת ניהול הזמנות פנימית של Atrium Micro Technologies, המחליפה את קובץ האקסל "מעקב הזמנות.xlsx".

- **Next.js 16** (App Router, Server Actions) + **TypeScript**
- **Neon** (Postgres serverless) + **Drizzle ORM**
- **shadcn/ui** + Tailwind, עברית RTL מלאה
- פריסה: **Vercel**

## מסכים

| מסך | נתיב | תיאור |
|---|---|---|
| הזמנות פתוחות | `/` | המסך היומיומי: קיבוץ לפי לקוח, סטטוס צבעוני, פעולות מהירות (הגיע / עריכה / סגירה / מחיקה), חיפוש וסינון |
| קליטת הזמנה | `/intake` | טופס ידני + אישור הזמנות סרוקות שממתינות ב-staging |
| סיכום חודשי | `/monthly` | טבלת רווחיות לפי חודש + ייצוא CSV (נפתח נכון באקסל בעברית) |

## התקנה מקומית

```bash
npm install
copy .env.example .env.local     # ולערוך את הערכים
npm run db:migrate               # יצירת הטבלאות ב-Neon
npm run db:seed                  # (רשות) נתוני דוגמה
npm run dev                      # http://localhost:3000
```

### משתני סביבה (`.env.local`)

| משתנה | תיאור |
|---|---|
| `DATABASE_URL` | מחרוזת חיבור **pooled** מ-Neon (הכתובת עם `-pooler`) |
| `APP_PASSWORD` | הסיסמה המשותפת לכניסה למערכת |
| `INGEST_TOKEN` | טוקן ל-API של קליטת הזמנות סרוקות |

## Neon

1. נכנסים ל-[console.neon.tech](https://console.neon.tech) ויוצרים פרויקט (התוכנית החינמית מספיקה).
2. מעתיקים את מחרוזת החיבור ה-**Pooled** (עם `-pooler` בכתובת) אל `DATABASE_URL`.
3. מריצים `npm run db:migrate`.

## פריסה ל-Vercel

```bash
npx vercel login
npx vercel --prod
```

ואז מגדירים את שלושת משתני הסביבה ב-Vercel (Project → Settings → Environment Variables) ועושים redeploy. לחלופין:

```bash
npx vercel env add DATABASE_URL production
npx vercel env add APP_PASSWORD production
npx vercel env add INGEST_TOKEN production
```

## הגירה מהאקסל (חד-פעמי)

```bash
# תצוגה מקדימה בלבד:
npx tsx scripts/import-xlsx.ts "C:\path\to\מעקב הזמנות.xlsx" --dry-run

# הרצה אמיתית (כותב ל-DATABASE_URL מה-.env.local):
npx tsx scripts/import-xlsx.ts "C:\path\to\מעקב הזמנות.xlsx"
```

הסקריפט קורא את גיליון "הזמנות פתוחות" ואת הגיליונות החודשיים ("יולי 2026" וכו'), מבצע דדופ לפי (מספר הזמנה, לקוח, P/N) וממזג שדות (מחיר קנייה ומשלוח מהגיליון החודשי, שדות מעקב מגיליון הפתוחות). שורות שקיימות רק בגיליון חודשי נקלטות כסגורות (`is_open=false`). הרצה חוזרת מדלגת על שורות קיימות.

## API לקליטת הזמנות סרוקות (OCR חיצוני)

```
POST /api/staged
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

גוף הבקשה — הזמנה אחת או מערך של הזמנות:

```json
{
  "customer": "134",
  "customerNote": "קבוצת רכש משהב\"ט - חטיבת מודיעין",
  "orderNumber": "4441537295",
  "orderDate": "2026-07-15",
  "sourceFormat": "mod",
  "sourceFile": "4441537295.pdf",
  "lines": [
    {
      "pn": "CH-USB-2-1.0AB",
      "sku": "10-813580624",
      "qty": 50,
      "unitPrice": 12.5,
      "contractDueDate": "2026-08-01",
      "notes": null
    }
  ]
}
```

- `sourceFormat`: `standard` | `mod` | `manual`
- תאריכים בפורמט ISO ‏`yyyy-mm-dd`
- תשובה: `201 { ok: true, ids: [...] }`, שגיאת ולידציה: `422`
- ההזמנות מופיעות במסך "קליטת הזמנה" ככרטיסים לאישור/עריכה/דחייה.

**חשוב — הזמנות משהב"ט:** מספר הזמנה של 10 ספרות שמתחיל ב-444. שדה `customer` חייב להיות מספר קבוצת הרכש ('134', '131' וכו'), לא "משרד הביטחון".

## חוקי הסטטוס (מסך הזמנות פתוחות)

לפי סדר עדיפויות:
1. סטטוס ידני: הגיע=ירוק, סופק חלקי=כתום, מאחר=אדום (גובר על הכל)
2. שטר מטען מלא → ירוק
3. "סופק" (בלי "לא סופק") בעדכון אספקה/הערות → כתום
4. תאריך אספקה חוזי עבר → אדום
5. אחרת → ניטרלי

## פקודות

| פקודה | תיאור |
|---|---|
| `npm run dev` | שרת פיתוח |
| `npm run build` | build לפרודקשן |
| `npm run test` | בדיקות יחידה (לוגיקת סטטוס) |
| `npm run db:generate` | יצירת מיגרציה מהסכימה |
| `npm run db:migrate` | הרצת מיגרציות |
| `npm run db:seed` | נתוני דוגמה |

## מבנה עתידי

האימות (סיסמה משותפת) מבודד ב-`src/lib/auth.ts` + `src/proxy.ts` — מוכן להחלפה ב-auth רב-משתמשים בעתיד בלי לגעת בשאר הקוד. כל מוטציה נרשמת ב-`audit_log`.
