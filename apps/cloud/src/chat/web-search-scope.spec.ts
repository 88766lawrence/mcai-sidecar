import { describe, expect, it } from "vitest";
import { applyUserWebSearchScope, requestedWebSearchSite, webSearchUrlWithinScope } from "./web-search-scope";

describe("user web search scope", () => {
 it("replaces a conflicting model site with the user's source rule", () => {
  expect(applyUserWebSearchScope({ action: "tool_call", tool: "web.search", arguments: { query: "Paper backup site:hangar.papermc.io" }, reason: "search" }, "搜索更新步骤，只参考 docs.papermc.io。" )).toMatchObject({ arguments: { query: "Paper backup site:docs.papermc.io" } });
 });
 it("matches host and path boundaries without accepting lookalikes", () => {
  const request="search site:docs.example.org/manual";
  expect(requestedWebSearchSite(request)).toBe("docs.example.org/manual");
  expect(webSearchUrlWithinScope("https://docs.example.org/manual/install",request)).toBe(true);
  expect(webSearchUrlWithinScope("https://docs.example.org.evil.test/manual",request)).toBe(false);
  expect(webSearchUrlWithinScope("https://docs.example.org/manual-other",request)).toBe(false);
  expect(webSearchUrlWithinScope("https://other.example.org/manual",request)).toBe(false);
 });
 it("does not restrict a merely mentioned domain or an unrelated tool", () => {
  expect(requestedWebSearchSite("compare docs.example.org and example.net")).toBeUndefined();
  const d={action:"tool_call" as const,tool:"files.list" as const,arguments:{path:"plugins"},reason:"read"};
  expect(applyUserWebSearchScope(d,"只参考 docs.example.org")).toBe(d);
 });
});
