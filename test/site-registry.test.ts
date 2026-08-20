import { describe, it, expect } from "vitest";
import { scriptIdFor, toMatchPattern } from "../src/background/site-registry";

describe("toMatchPattern", () => {
  it("accepts a bare hostname and assumes https", () => {
    expect(toMatchPattern("vimeo.com")).toBe("https://vimeo.com/*");
  });

  it("keeps the whole host and widens the path", () => {
    // Narrower than /* breaks the SPA navigation every course platform uses.
    expect(toMatchPattern("https://www.coursera.org/learn/ml/lecture/7")).toBe(
      "https://www.coursera.org/*",
    );
  });

  it("preserves http for a local or intranet lecture server", () => {
    expect(toMatchPattern("http://lectures.uni.edu")).toBe("http://lectures.uni.edu/*");
  });

  it("treats a subdomain as its own site, since the permission is per host", () => {
    expect(toMatchPattern("player.vimeo.com")).not.toBe(toMatchPattern("vimeo.com"));
  });

  it("rejects input that would widen the grant beyond one site", () => {
    // The whole point of runtime registration is that the user never accidentally
    // grants every site they visit.
    for (const junk of ["<all_urls>", "*", "*://*/*", ""]) {
      expect(() => toMatchPattern(junk)).toThrow();
    }
  });

  it("rejects non-web schemes", () => {
    expect(() => toMatchPattern("file:///Users/me/lecture.mp4")).toThrow(/http/i);
    expect(() => toMatchPattern("chrome://extensions")).toThrow();
  });

  it("rejects a hostname with no dot, which is never a real site", () => {
    expect(() => toMatchPattern("localhost")).toThrow();
  });
});

describe("scriptIdFor", () => {
  it("is stable for the same pattern", () => {
    expect(scriptIdFor("https://vimeo.com/*")).toBe(scriptIdFor("https://vimeo.com/*"));
  });

  it("distinguishes different sites", () => {
    expect(scriptIdFor("https://vimeo.com/*")).not.toBe(scriptIdFor("https://coursera.org/*"));
  });

  it("produces an id with no characters chrome.scripting would reject", () => {
    expect(scriptIdFor("https://vimeo.com/*")).toMatch(/^[a-zA-Z0-9-]+$/);
  });
});
