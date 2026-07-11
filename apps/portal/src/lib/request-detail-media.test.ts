import { describe, expect, it } from "vitest";
import { buildMediaGroups } from "./request-detail-media";

const PNG = `iVBORw0KGgo${"A".repeat(40)}`;
const GIF = `R0lGODlhAQ${"B".repeat(40)}`;

describe("buildMediaGroups", () => {
  it("groups request images before response images", () => {
    expect(buildMediaGroups({ image: PNG }, { image: GIF })).toEqual([
      {
        kind: "request",
        images: [{ url: `data:image/png;base64,${PNG}`, path: "image" }],
      },
      {
        kind: "response",
        images: [{ url: `data:image/gif;base64,${GIF}`, path: "image" }],
      },
    ]);
  });

  it("omits empty groups and de-duplicates repeated images", () => {
    expect(buildMediaGroups(null, { first: PNG, again: PNG })).toEqual([
      {
        kind: "response",
        images: [{ url: `data:image/png;base64,${PNG}`, path: "first" }],
      },
    ]);
    expect(buildMediaGroups(null, null)).toEqual([]);
  });
});
