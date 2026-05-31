// Minimal pure function used by the harness smoke test and as the seed for the
// gateway /version endpoint. Kept dependency-free on purpose.

export const version = (): string => "0.0.0";
