import { describe, expect, it } from "vitest";
import { isSupportedUrl } from "./tabs";

describe("isSupportedUrl", () => {
  it.each(["https://example.com", "http://localhost:3000"])(
    "accepts %s",
    (url) => expect(isSupportedUrl(url)).toBe(true),
  );

  it.each(["chrome://settings", "file:///tmp/a.txt", "devtools://devtools", "not a url"])(
    "rejects %s",
    (url) => expect(isSupportedUrl(url)).toBe(false),
  );
});
