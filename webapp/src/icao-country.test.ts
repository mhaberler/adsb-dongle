import { describe, expect, test } from "bun:test";
import { icaoCountry } from "./icao-country";

describe("icaoCountry", () => {
  test("German, Austrian and US blocks", () => {
    expect(icaoCountry("3c6444")?.code).toBe("DE");
    expect(icaoCountry("440123")?.code).toBe("AT");
    expect(icaoCountry("A1B2C3")?.code).toBe("US");
  });

  test("English name and flag emoji", () => {
    const c = icaoCountry("3c6444")!;
    expect(c.name).toBe("Germany");
    expect(c.flag).toBe("🇩🇪");
  });

  test("first match wins: Isle of Man before UK, Hong Kong before China", () => {
    expect(icaoCountry("43e800")?.code).toBe("IM");
    expect(icaoCountry("400800")?.code).toBe("GB");
    expect(icaoCountry("789123")?.code).toBe("HK");
    expect(icaoCountry("780123")?.code).toBe("CN");
  });

  test("ICAO special addresses have no flag", () => {
    expect(icaoCountry("f00001")).toEqual({
      code: "-T",
      name: "ICAO (temporary address)",
      flag: "",
    });
  });

  test("unallocated, non-ICAO and empty addresses", () => {
    expect(icaoCountry("000001")).toBeNull();
    expect(icaoCountry("~3c6444")).toBeNull();
    expect(icaoCountry("")).toBeNull();
  });
});
