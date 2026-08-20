import { describe, expect, it } from "vitest";
import {
  boiCurrentUrl,
  boiSeriesUrl,
  convertToIls,
  parseBoiCurrentRate,
  parseBoiSeriesCsv,
  pickRateOnOrBefore,
} from "./fx";

describe("boi urls", () => {
  it("builds the series key from the currency", () => {
    expect(boiSeriesUrl("usd", "2026-08-01", "2026-08-19")).toContain("/RER_USD_ILS?");
    expect(boiSeriesUrl("USD", "2026-08-01", "2026-08-19")).toContain(
      "startPeriod=2026-08-01&endPeriod=2026-08-19",
    );
    expect(boiCurrentUrl("usd")).toContain("key=USD");
  });
});

describe("parseBoiSeriesCsv", () => {
  // SDMX-CSV as the Bank of Israel's Fusion server emits it. The key columns in
  // front of the observation vary between flavours, which is why the parser reads
  // the header instead of counting commas.
  const sdmx = [
    "STRUCTURE,STRUCTURE_ID,ACTION,SERIES_CODE,FREQ,TIME_PERIOD,OBS_VALUE",
    "dataflow,BOI.STATISTICS:EXR(1.0),I,RER_USD_ILS,D,2026-08-17,3.7010",
    "dataflow,BOI.STATISTICS:EXR(1.0),I,RER_USD_ILS,D,2026-08-18,3.7210",
    "dataflow,BOI.STATISTICS:EXR(1.0),I,RER_USD_ILS,D,2026-08-19,3.6890",
  ].join("\n");

  it("reads dates and rates by column name", () => {
    expect(parseBoiSeriesCsv(sdmx)).toEqual([
      { date: "2026-08-17", rate: 3.701 },
      { date: "2026-08-18", rate: 3.721 },
      { date: "2026-08-19", rate: 3.689 },
    ]);
  });

  it("survives a different column order and extra columns", () => {
    const reordered = [
      "OBS_VALUE,TIME_PERIOD,SERIES_CODE,COMMENT",
      "3.7210,2026-08-18,RER_USD_ILS,\"quoted, with comma\"",
    ].join("\n");
    expect(parseBoiSeriesCsv(reordered)).toEqual([{ date: "2026-08-18", rate: 3.721 }]);
  });

  it("skips rows it cannot read rather than inventing a rate", () => {
    const messy = [
      "TIME_PERIOD,OBS_VALUE",
      "2026-08-18,3.7210",
      "2026-08-19,", // published day, value not out yet
      "not-a-date,3.5",
      "2026-08-20,0", // a zero rate is not a rate
    ].join("\n");
    expect(parseBoiSeriesCsv(messy)).toEqual([{ date: "2026-08-18", rate: 3.721 }]);
  });

  it("returns nothing when the header is not SDMX at all", () => {
    expect(parseBoiSeriesCsv("<html>error</html>")).toEqual([]);
    expect(parseBoiSeriesCsv("")).toEqual([]);
    expect(parseBoiSeriesCsv("TIME_PERIOD,OBS_VALUE")).toEqual([]);
  });

  it("sorts by date even when the series arrives newest-first", () => {
    const desc = ["TIME_PERIOD,OBS_VALUE", "2026-08-19,3.6", "2026-08-17,3.7"].join("\n");
    expect(parseBoiSeriesCsv(desc).map((o) => o.date)).toEqual(["2026-08-17", "2026-08-19"]);
  });

  it("a monthly series lands on the first of the month", () => {
    expect(parseBoiSeriesCsv(["TIME_PERIOD,OBS_VALUE", "2026-08,3.71"].join("\n"))).toEqual([
      { date: "2026-08-01", rate: 3.71 },
    ]);
  });
});

describe("parseBoiCurrentRate", () => {
  it("takes the date part of lastUpdate", () => {
    expect(
      parseBoiCurrentRate({
        key: "USD",
        currentExchangeRate: 3.721,
        currentChange: 0.13,
        lastUpdate: "2026-08-19T13:24:04.8725333Z",
      }),
    ).toEqual({ date: "2026-08-19", rate: 3.721 });
  });

  it("refuses anything it cannot read", () => {
    expect(parseBoiCurrentRate(null)).toBeNull();
    expect(parseBoiCurrentRate({ currentExchangeRate: 3.7 })).toBeNull();
    expect(parseBoiCurrentRate({ currentExchangeRate: 0, lastUpdate: "2026-08-19" })).toBeNull();
    expect(parseBoiCurrentRate({ currentExchangeRate: "x", lastUpdate: "2026-08-19" })).toBeNull();
  });
});

describe("pickRateOnOrBefore", () => {
  const series = [
    { date: "2026-08-13", rate: 3.7 }, // Thursday
    { date: "2026-08-17", rate: 3.72 }, // Monday
  ];

  it("takes the exact day when it was published", () => {
    expect(pickRateOnOrBefore(series, "2026-08-17")).toEqual({ date: "2026-08-17", rate: 3.72 });
  });

  // The reason this function exists: no rate is published on Friday, Saturday or a
  // holiday, so a delivery then is converted at the last published rate — and the
  // row records which day that was.
  it("falls back to the last published rate over a closed weekend", () => {
    expect(pickRateOnOrBefore(series, "2026-08-15")).toEqual({ date: "2026-08-13", rate: 3.7 });
    expect(pickRateOnOrBefore(series, "2026-08-16")).toEqual({ date: "2026-08-13", rate: 3.7 });
  });

  it("never looks forward, and reports nothing before the series starts", () => {
    expect(pickRateOnOrBefore(series, "2026-08-12")).toBeNull();
    expect(pickRateOnOrBefore([], "2026-08-17")).toBeNull();
  });
});

describe("convertToIls", () => {
  it("rounds to agorot", () => {
    expect(convertToIls(41.5, 3.721)).toBe(154.42);
    expect(convertToIls(10, 3.7)).toBe(37);
    // 0.005 rounds up, so the figure never silently loses an agora downward.
    expect(convertToIls(1, 3.005)).toBe(3.01);
  });
});
