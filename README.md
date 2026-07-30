# AMT — מערכת מעקב הזמנות

מערכת ניהול הזמנות פנימית של Atrium Micro Technologies, המחליפה את קובץ האקסל "מעקב הזמנות.xlsx".

- **Next.js 16** (App Router, Server Actions) + **TypeScript**
- **Neon** (Postgres serverless) + **Drizzle ORM**
- **shadcn/ui** + Tailwind, עברית RTL מלאה
- פריסה: **Vercel**

**סביבה חיה:** https://amt-db.vercel.app · ריפו: https://github.com/amt-eldan/amt-db (מחובר ל-Vercel — כל `git push` ל-`main` מפעיל deploy אוטומטי).

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
| `BOL_AGENT_TOKEN` | טוקן ל-API של מעקב שטרי המטען (נפרד, כדי שיהיה אפשר להחליף אותו לבד) |

## Neon

1. נכנסים ל-[console.neon.tech](https://console.neon.tech) ויוצרים פרויקט (התוכנית החינמית מספיקה).
2. מעתיקים את מחרוזת החיבור ה-**Pooled** (עם `-pooler` בכתובת) אל `DATABASE_URL`.
3. מריצים `npm run db:migrate`.

## פריסה ל-Vercel

```bash
npx vercel login
npx vercel --prod
```

ואז מגדירים את משתני הסביבה ב-Vercel (Project → Settings → Environment Variables) ועושים redeploy. לחלופין:

```bash
npx vercel env add DATABASE_URL production
npx vercel env add APP_PASSWORD production
npx vercel env add INGEST_TOKEN production
npx vercel env add BOL_AGENT_TOKEN production
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

## API למעקב שטרי מטען (agent חיצוני)

במקום לסרוק את תיבת המייל בעיוורון ולתחזק קובץ אקסל נפרד, **המערכת מכתיבה את החיפוש**: היא
יודעת אילו שורות פתוחות עדיין חסרות שטר מטען, ומספקת לכל אחת את מפתחות החיפוש. ה-agent מחפש
במייל לפי המפתחות האלה ומחזיר את המספר שמצא — והמערכת כותבת אותו לשורה המדויקת.

### 1. קבלת רשימת העבודה

```
GET /api/bol/worklist
Authorization: Bearer <BOL_AGENT_TOKEN>
```

תשובה — רק שורות פתוחות שחסר בהן שטר מטען, הדחופות קודם:

```json
{
  "ok": true,
  "count": 1,
  "lines": [
    {
      "lineId": 42,
      "orderNumber": "4441537295",
      "customer": "134",
      "pn": "CH-USB-2-1.0AB",
      "sku": "10-813580624",
      "poNumber": "PO-8871",
      "supplier": "AXTON",
      "contractDueDate": "2026-08-01"
    }
  ]
}
```

### 2. החזרת שטרי מטען שנמצאו

```
POST /api/bol/matches
Authorization: Bearer <BOL_AGENT_TOKEN>
Content-Type: application/json
```

גוף הבקשה — התאמה אחת או מערך. `lineId` הוא זה שהתקבל ב-worklist, וזה מה שקושר את המספר
לשורה אחת ויחידה:

```json
[
  {
    "lineId": 42,
    "bol": "1Z999AA10123456784",
    "carrier": "UPS",
    "confidence": 0.95,
    "statusText": "Delivered",
    "sourceEmailId": "18fabc123",
    "sourceQuote": "Your UPS shipment for PO-8871 has been delivered"
  }
]
```

תשובה מפרטת מה נכתב ומה לא, כדי שה-agent ידווח על הדילוגים בסיכום היומי:

```json
{ "ok": true, "written": 1, "skipped": 0, "results": [{ "lineId": 42, "status": "written" }] }
```

### סדר עדיפות המפתחות בחיפוש

1. **`poNumber`** — הזמנת הרכש שלנו לספק; מופיע באישורי המשלוח שלו. האות החזק ביותר.
2. **`pn`** — מפריד בין פריטים במשלוח שמכסה כמה שורות. חוזר על עצמו בין הזמנות, ולכן לא מזהה לבד.
3. **`orderNumber`** — משני; הספק לרוב לא מכיר אותו.
4. **`supplier`** — אישוש בלבד (דומיין/שם השולח).

מייל אחד שמכסה כמה פריטים → כמה התאמות, אחת לכל `lineId`, עם אותו `sourceEmailId`.

### מה המערכת לא תיתן ל-agent לעשות

מילוי שטר מטען צובע את השורה ירוק ("הגיע"), ולכן הכתיבה מוגנת:

- **לא דורסת** שטר מטען קיים — לא של אלדן ולא של ריצה קודמת. במקרה של ערך שונה מוחזר
  `bol already set to a different value — needs manual review`.
- **רק שורות פתוחות.**
- **התאמה עמומה לא נכתבת בניחוש** — `confidence` מתחת ל-0.5 מדולג ומדווח. התאמה בלי
  `confidence` נחשבת מאושרת ע"י ה-agent.
- **כל כתיבה מתועדת** ב-`audit_log` עם מזהה המייל, הציטוט ורמת הוודאות — אפשר לראות בדיוק
  מאיפה כל מספר בא.
- שורות שמולאו אוטומטית מסומנות בממשק (אייקון + הודעה במסך העריכה). עריכה ידנית של שטר
  המטען מעבירה אליו בעלות (`bol_source` הופך ל-`manual`).

ריצה חוזרת בטוחה: worklist כבר לא מחזיר שורות שמולאו, ולכן אין כפילויות.

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
| `npm run test` | בדיקות יחידה (לוגיקת סטטוס, ולידציה, הגנות שטרי מטען) |
| `npm run db:generate` | יצירת מיגרציה מהסכימה |
| `npm run db:migrate` | הרצת מיגרציות |
| `npm run db:seed` | נתוני דוגמה |

## מבנה עתידי

האימות (סיסמה משותפת) מבודד ב-`src/lib/auth.ts` + `src/proxy.ts` — מוכן להחלפה ב-auth רב-משתמשים בעתיד בלי לגעת בשאר הקוד. כל מוטציה נרשמת ב-`audit_log`.
