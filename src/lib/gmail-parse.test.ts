import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  extractBody,
  headerValue,
  htmlToText,
  messageDate,
  parseMessage,
  type GmailMessage,
} from "./gmail-parse";

const b64 = (text: string) =>
  Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("decodeBase64Url", () => {
  it("decodes Gmail's unpadded URL alphabet", () => {
    expect(decodeBase64Url(b64("Tracking Number: 1Z999AA10123456784"))).toBe(
      "Tracking Number: 1Z999AA10123456784",
    );
  });

  it("round-trips Hebrew", () => {
    expect(decodeBase64Url(b64("שטר מטען: 1234567890"))).toBe("שטר מטען: 1234567890");
  });

  it("is empty rather than throwing on nothing", () => {
    expect(decodeBase64Url(undefined)).toBe("");
    expect(decodeBase64Url("")).toBe("");
  });
});

describe("htmlToText", () => {
  it("keeps the line break between a label and its value", () => {
    // The extractor measures label distance in characters, so a table cell
    // boundary that vanished would silently widen that window.
    const text = htmlToText("<tr><td>Tracking Number</td><td>1Z999AA10123456784</td></tr>");
    expect(text).toContain("Tracking Number");
    expect(text).toContain("1Z999AA10123456784");
    expect(text.indexOf("1Z999")).toBeGreaterThan(text.indexOf("Tracking"));
  });

  it("drops scripts and styles entirely", () => {
    expect(htmlToText("<style>.a{color:red}</style><p>hello</p>")).toBe("hello");
    expect(htmlToText("<script>var x = 1;</script><p>hello</p>")).toBe("hello");
  });

  it("decodes the entities that carry identifiers", () => {
    expect(htmlToText("<p>PO&nbsp;4501234567 &amp; more</p>")).toBe("PO 4501234567 & more");
  });

  it("turns br into a newline", () => {
    expect(htmlToText("a<br>b")).toBe("a\nb");
  });
});

describe("extractBody", () => {
  it("prefers text/plain over the html twin", () => {
    const body = extractBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("plain wins") } },
        { mimeType: "text/html", body: { data: b64("<p>html loses</p>") } },
      ],
    });
    expect(body).toBe("plain wins");
  });

  it("falls back to html when that is all there is", () => {
    const body = extractBody({
      mimeType: "text/html",
      body: { data: b64("<p>Tracking Number: 1Z999AA10123456784</p>") },
    });
    expect(body).toBe("Tracking Number: 1Z999AA10123456784");
  });

  it("reaches a body nested several levels down", () => {
    const body = extractBody({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/related",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [{ mimeType: "text/plain", body: { data: b64("deep body") } }],
            },
          ],
        },
      ],
    });
    expect(body).toBe("deep body");
  });

  // A PDF's base64 read as text is a source of digit strings that look like
  // tracking numbers and are not.
  it("skips attachments", () => {
    const body = extractBody({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("the mail itself") } },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { data: b64("771234567890771234567890") },
        },
      ],
    });
    expect(body).toBe("the mail itself");
  });

  it("is empty for a message with no body at all", () => {
    expect(extractBody(undefined)).toBe("");
    expect(extractBody({ mimeType: "multipart/mixed" })).toBe("");
  });
});

describe("headerValue", () => {
  const part = { headers: [{ name: "SUBJECT", value: " Shipped " }] };

  it("finds a header whatever its casing, trimmed", () => {
    expect(headerValue(part, "subject")).toBe("Shipped");
  });

  it("is empty for a header that is not there", () => {
    expect(headerValue(part, "From")).toBe("");
  });
});

describe("messageDate", () => {
  it("reads Gmail's millisecond string", () => {
    expect(messageDate({ internalDate: String(Date.UTC(2026, 7, 20, 9, 0)) })).toBe("2026-08-20");
  });

  it("is null when Gmail sent none", () => {
    expect(messageDate({})).toBeNull();
    expect(messageDate({ internalDate: "0" })).toBeNull();
  });
});

describe("parseMessage", () => {
  const message: GmailMessage = {
    id: "m1",
    threadId: "t1",
    internalDate: String(Date.UTC(2026, 7, 20)),
    payload: {
      headers: [
        { name: "Subject", value: "Shipment 1Z999AA10123456784 dispatched" },
        { name: "From", value: "ship@digikey.com" },
      ],
      mimeType: "text/plain",
      body: { data: b64("PO 4501234567 is on its way.") },
    },
  };

  it("flattens a message into the fields the sync searches", () => {
    const parsed = parseMessage(message);
    expect(parsed).toMatchObject({
      id: "m1",
      threadId: "t1",
      from: "ship@digikey.com",
      date: "2026-08-20",
    });
    expect(parsed.subject).toContain("1Z999AA10123456784");
  });

  // Carriers put the number in the subject, so it has to be searchable alongside
  // the body — and next to its own label, not the body's.
  it("puts the subject in the searchable text, ahead of the body", () => {
    const parsed = parseMessage(message);
    expect(parsed.text.indexOf("1Z999AA10123456784")).toBeLessThan(
      parsed.text.indexOf("4501234567"),
    );
  });

  it("survives a message with nothing in it", () => {
    expect(parseMessage({})).toMatchObject({ id: "", subject: "", from: "", text: "" });
  });
});
