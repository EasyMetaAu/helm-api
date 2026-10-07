// Backwards-compatible entrypoint: keep all subscription client versions in one snapshot.
import { syncClientVersions } from "./sync-client-versions.js";

await syncClientVersions({ token: process.env.GITHUB_TOKEN });
