import { describe, expect, it } from "vitest";
import { href, parseHash } from "../src/app/router.js";

describe("router", () => {
  it("reads the filters of the review board from the address", () => {
    expect(parseHash("#/themes/sql/board?show=learned&starred=1&find=index%20scan")).toEqual({
      name: "board",
      slug: "sql",
      show: "learned",
      starred: true,
      find: "index scan",
    });
    expect(parseHash("#/themes/sql/board")).toEqual({ name: "board", slug: "sql", show: "all", starred: false, find: "" });
    // An unknown filter shows all concepts.
    expect(parseHash("#/themes/sql/board?show=other")).toMatchObject({ show: "all" });
  });

  it("writes the filters into the address, and reads the same filters back", () => {
    const filters = { show: "learned", starred: true, find: "index " } as const;
    const hash = href.board("sql", filters);
    expect(hash).toBe("#/themes/sql/board?show=learned&starred=1&find=index+");
    expect(parseHash(hash)).toEqual({ name: "board", slug: "sql", ...filters });
    expect(href.board("sql")).toBe("#/themes/sql/board");
    expect(href.board("sql", { show: "all", starred: false, find: "" })).toBe("#/themes/sql/board");
  });
});
