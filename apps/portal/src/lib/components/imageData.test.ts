import { describe, expect, it } from "vitest";
import { collectImages, imageDataUrl } from "./imageData";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("imageDataUrl", () => {
  it("wraps raw image base64 and passes through image data URLs", () => {
    const jpeg = `/9j/4AAQSkZJRgABAQ${"A".repeat(40)}`;
    const gif = `R0lGODlhAQABAIAAAA${"A".repeat(40)}`;
    const webp = `data:image/webp;base64,${"UklGRiQAAABXRUJQ".padEnd(48, "A")}`;
    expect(imageDataUrl(PNG_1PX)).toBe(`data:image/png;base64,${PNG_1PX}`);
    expect(imageDataUrl(jpeg)).toBe(`data:image/jpeg;base64,${jpeg}`);
    expect(imageDataUrl(gif)).toBe(`data:image/gif;base64,${gif}`);
    expect(imageDataUrl(webp)).toBe(webp);
  });

  it("rejects ordinary text, short strings, and non-strings", () => {
    expect(imageDataUrl("hello world, this is a normal sentence.")).toBeNull();
    expect(imageDataUrl("iVBORw0")).toBeNull();
    expect(imageDataUrl(42)).toBeNull();
    expect(imageDataUrl(null)).toBeNull();
    expect(imageDataUrl({ data: PNG_1PX })).toBeNull();
  });
});

describe("collectImages", () => {
  const GIF = `R0lGODlhAQABAIAAAA${"A".repeat(40)}`;

  it("finds a generated image nested in a Gemini response", () => {
    const response = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ inlineData: { mimeType: "image/png", data: PNG_1PX } }],
          },
        },
      ],
    };
    expect(collectImages(response)).toEqual([
      {
        url: `data:image/png;base64,${PNG_1PX}`,
        path: "candidates.0.content.parts.0.inlineData.data",
      },
    ]);
  });

  it("preserves order, de-duplicates images, and caps the gallery", () => {
    expect(
      collectImages({ a: PNG_1PX, b: [GIF, GIF] }).map((image) => image.url),
    ).toEqual([
      `data:image/png;base64,${PNG_1PX}`,
      `data:image/gif;base64,${GIF}`,
    ]);

    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      many[`k${i}`] = `data:image/png;base64,AAAA${i}${"B".repeat(40)}`;
    }
    expect(collectImages(many)).toHaveLength(24);
  });

  it("returns an empty list when the payload has no images", () => {
    expect(collectImages({ hello: "world", nested: [1, 2] })).toEqual([]);
    expect(collectImages("plain string")).toEqual([]);
    expect(collectImages(null)).toEqual([]);
  });
});
