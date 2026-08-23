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

// Verbatim responses from the Bank of Israel, captured 2026-08-23. The fixtures
// above were written before the service was reachable and guessed at the header;
// these are the real thing, and they are what the parser is actually held to.
describe("the responses the Bank of Israel really returns", () => {
  const REAL_USD_CSV = [
    "SERIES_CODE,FREQ,BASE_CURRENCY,COUNTER_CURRENCY,UNIT_MEASURE,DATA_TYPE,DATA_SOURCE,TIME_COLLECT,CONF_STATUS,PUB_WEBSITE,UNIT_MULT,COMMENTS,TIME_PERIOD,OBS_VALUE,RELEASE_STATUS",
    "RER_USD_ILS,D,USD,ILS,ILS,OF00,BOI_MRKT,V,F,Y,0,,2026-08-06,3.013,YP",
    "RER_USD_ILS,D,USD,ILS,ILS,OF00,BOI_MRKT,V,F,Y,0,,2026-08-07,3.006,YP",
    "RER_USD_ILS,D,USD,ILS,ILS,OF00,BOI_MRKT,V,F,Y,0,,2026-08-10,2.998,YP",
    "RER_USD_ILS,D,USD,ILS,ILS,OF00,BOI_MRKT,V,F,Y,0,,2026-08-11,3.005,YP",
    "RER_USD_ILS,D,USD,ILS,ILS,OF00,BOI_MRKT,V,F,Y,0,,2026-08-12,2.991,YP",
  ].join("\n");

  it("reads the real SDMX-CSV header, twelve key columns and all", () => {
    expect(parseBoiSeriesCsv(REAL_USD_CSV)).toEqual([
      { date: "2026-08-06", rate: 3.013 },
      { date: "2026-08-07", rate: 3.006 },
      { date: "2026-08-10", rate: 2.998 },
      { date: "2026-08-11", rate: 3.005 },
      { date: "2026-08-12", rate: 2.991 },
    ]);
  });

  // 08-08 and 08-09 are simply absent from the real series. This is the gap the
  // whole on-or-before lookup exists for: goods delivered then convert at the 7th's
  // rate, and the row records that it was the 7th's.
  it("converts a delivery made on a day with no published rate", () => {
    const series = parseBoiSeriesCsv(REAL_USD_CSV);
    expect(pickRateOnOrBefore(series, "2026-08-09")).toEqual({
      date: "2026-08-07",
      rate: 3.006,
    });
    expect(pickRateOnOrBefore(series, "2026-08-05")).toBeNull();
  });

  it("divides out UNIT_MULT: the yen series quotes 100 yen, not one", () => {
    const jpy = [
      "SERIES_CODE,FREQ,BASE_CURRENCY,COUNTER_CURRENCY,UNIT_MEASURE,DATA_TYPE,DATA_SOURCE,TIME_COLLECT,CONF_STATUS,PUB_WEBSITE,UNIT_MULT,COMMENTS,TIME_PERIOD,OBS_VALUE,RELEASE_STATUS",
      "RER_JPY_ILS,D,JPY,ILS,ILS,OF00,BOI_MRKT,V,F,Y,2,,2026-08-21,1.8873,YP",
    ].join("\n");
    expect(parseBoiSeriesCsv(jpy)).toEqual([{ date: "2026-08-21", rate: 0.018873 }]);
  });

  it("reads the real GetExchangeRate payload, unit field included", () => {
    // Note the date: fetched on the 23rd, and the rate is still the 21st's.
    expect(
      parseBoiCurrentRate({
        key: "USD",
        currentExchangeRate: 2.991,
        currentChange: -0.0334224598930481283422459900,
        unit: 1,
        lastUpdate: "2026-08-21T09:23:04.0603079Z",
      }),
    ).toEqual({ date: "2026-08-21", rate: 2.991 });

    expect(
      parseBoiCurrentRate({
        key: "JPY",
        currentExchangeRate: 1.8873,
        unit: 100,
        lastUpdate: "2026-08-21T09:23:04.0603079Z",
      }),
    ).toEqual({ date: "2026-08-21", rate: 0.018873 });
  });

  it("treats a payload with no unit as per-one rather than refusing it", () => {
    expect(
      parseBoiCurrentRate({ currentExchangeRate: 3.5017, lastUpdate: "2026-08-21T09:23:04Z" }),
    ).toEqual({ date: "2026-08-21", rate: 3.5017 });
  });
});
