import { collectImages, type CollectedImage } from "./components/imageData";

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
