import { collectImages, type CollectedImage } from "./components/imageData";

const DETACHED_IMAGE =
  /^(data:image\/[^;,]+;base64,)?helm-blob:sha256:([0-9a-f]{64})$/i;

export async function restoreDetachedImages(
  value: unknown,
  load: (sha256: string) => Promise<string | null>,
): Promise<{ value: unknown; missing: boolean }> {
  const blobs = new Map<string, string | null>();
  function collect(node: unknown): void {
    if (typeof node === "string") {
      const ref = DETACHED_IMAGE.exec(node);
      if (ref) blobs.set(ref[2], null);
    } else if (node && typeof node === "object") {
      for (const child of Object.values(node)) collect(child);
    }
  }
  function restore(node: unknown): unknown {
    if (typeof node === "string") {
      const ref = DETACHED_IMAGE.exec(node);
      const data = ref && blobs.get(ref[2]);
      return data ? `${ref?.[1] ?? ""}${data}` : node;
    }
    if (Array.isArray(node)) return node.map(restore);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, restore(child)]),
      );
    }
    return node;
  }

  collect(value);
  // Fetch sequentially so a single detail view does not reserve multiple blob
  // response-work leases at once. Keep the original reference when bytes are gone.
  for (const sha of blobs.keys()) blobs.set(sha, await load(sha));
  return {
    value: blobs.size > 0 ? restore(value) : value,
    missing: [...blobs.values()].some((blob) => blob === null),
  };
}

export interface RequestDetailMediaGroup {
  kind: "request" | "response";
  images: CollectedImage[];
}

export function buildMediaGroups(
  request: unknown,
  response: unknown,
): RequestDetailMediaGroup[] {
  const groups: RequestDetailMediaGroup[] = [
    { kind: "request", images: collectImages(request) },
    { kind: "response", images: collectImages(response) },
  ];
  return groups.filter((group) => group.images.length > 0);
}
