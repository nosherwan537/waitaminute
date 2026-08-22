import { describe, it, expect } from "vitest";
import {
  patternCovers,
  scriptIdFor,
  shouldHaveContentScript,
  toMatchPattern,
} from "../src/background/site-registry";

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

describe("shouldHaveContentScript", () => {
  const sites = ["https://vimeo.com/*", "http://lectures.uni.edu/*"];

  it("says yes for YouTube, which is matched statically in the manifest", () => {
    expect(shouldHaveContentScript("https://www.youtube.com/watch?v=abc", sites)).toBe(true);
  });

  it("says yes for a site the user opted into at runtime", () => {
    expect(shouldHaveContentScript("https://vimeo.com/12345", sites)).toBe(true);
    expect(shouldHaveContentScript("http://lectures.uni.edu/w1", sites)).toBe(true);
  });

  it("says no for an ordinary page, which must stay silent", () => {
    // The whole point of the split: a failed sendMessage on a page we were
    // never on is correct, and warning about it would be noise on every press.
    expect(shouldHaveContentScript("https://news.example.com/", sites)).toBe(false);
    expect(shouldHaveContentScript("https://mail.google.com/", [])).toBe(false);
  });

  it("does not treat a subdomain or a lookalike host as a match", () => {
    expect(shouldHaveContentScript("https://player.vimeo.com/v/1", sites)).toBe(false);
    expect(shouldHaveContentScript("https://youtube.com.evil.test/", sites)).toBe(false);
    expect(shouldHaveContentScript("https://m.youtube.com/watch?v=a", sites)).toBe(false);
  });

  it("holds the scheme, so http never satisfies an https pattern", () => {
    expect(shouldHaveContentScript("http://vimeo.com/12345", sites)).toBe(false);
  });

  it("says no when the URL is missing or unparseable", () => {
    // chrome.tabs omits url without the host permission, and a tab mid-load
    // can report nothing at all. Neither is a stale script.
    expect(shouldHaveContentScript(undefined, sites)).toBe(false);
    expect(shouldHaveContentScript("", sites)).toBe(false);
    expect(shouldHaveContentScript("not a url", sites)).toBe(false);
  });

  it("rejects a malformed pattern rather than matching everything", () => {
    expect(patternCovers("vimeo.com", "https://vimeo.com/1")).toBe(false);
    expect(patternCovers("", "https://vimeo.com/1")).toBe(false);
  });
});
