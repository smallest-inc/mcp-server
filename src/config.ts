// Overridable for other regions or non-prod environments (e.g. https://api.dev.smallest.ai/atoms/v1).
// Every Atoms HTTP and WebSocket call derives its base from this one value.
export const ATOMS_API_URL = process.env.ATOMS_API_URL || "https://api.smallest.ai/atoms/v1";
