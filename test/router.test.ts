import { describe, expect, it } from "vitest";
import { href, parseHash } from "../src/app/router.js";

describe("router", () => {
  it("reads the filters of the review board from the address", () => {
    expect(parseHash("#/subjects/sql/board?show=learned&starred=1&find=index%20scan")).toEqual({
      name: "board",
      slug: "sql",
      show: "learned",
      starred: true,
      find: "index scan",
    });
    expect(parseHash("#/subjects/sql/board")).toEqual({ name: "board", slug: "sql", show: "all", starred: false, find: "" });
    // An unknown filter shows all concepts.
    expect(parseHash("#/subjects/sql/board?show=other")).toMatchObject({ show: "all" });
  });

  it("opens the concept map at a concept or at a module", () => {
    expect(parseHash(href.map("sql", "b-tree-index"))).toEqual({ name: "map", slug: "sql", concept: "b-tree-index", module: null });
    expect(parseHash(href.mapModule("sql", 3))).toEqual({ name: "map", slug: "sql", concept: null, module: 3 });
    // A module number that is not valid opens the map at the start.
    expect(parseHash("#/subjects/sql/map?module=x")).toMatchObject({ module: null });
  });

  it("opens the book page, also with the plan for a new run", () => {
    expect(parseHash(href.book("sql", "pro-git"))).toEqual({ name: "book", slug: "sql", book: "pro-git", view: null });
    expect(parseHash(href.book("sql", "pro-git", "plan"))).toEqual({ name: "book", slug: "sql", book: "pro-git", view: "plan" });
    expect(parseHash("#/subjects/sql/books/pro-git?view=other")).toMatchObject({ view: null });
  });

  it("writes the filters into the address, and reads the same filters back", () => {
    const filters = { show: "learned", starred: true, find: "index " } as const;
    const hash = href.board("sql", filters);
    expect(hash).toBe("#/subjects/sql/board?show=learned&starred=1&find=index+");
    expect(parseHash(hash)).toEqual({ name: "board", slug: "sql", ...filters });
    expect(href.board("sql")).toBe("#/subjects/sql/board");
    expect(href.board("sql", { show: "all", starred: false, find: "" })).toBe("#/subjects/sql/board");
  });
});
