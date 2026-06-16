// Base host for all Smallest AI APIs.
// Defaults to production. Override for non-prod environments, e.g.:
//   SMALLEST_API_BASE=https://api.dev.smallest.ai
const API_BASE = process.env.SMALLEST_API_BASE ?? "https://api.smallest.ai";

export const ATOMS_API_URL = `${API_BASE}/atoms/v1`;
export const WAVES_API_URL = `${API_BASE}/waves/v1`;
export const PAYMENTS_API_URL = `${API_BASE}/payment/v1`;
