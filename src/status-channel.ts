export const AUTOPILOT_STATUS_CUSTOM_TYPE = "pi-autopilot-status-v1";
export interface AutopilotStatusEntryData { readonly status: string; }
export function buildAutopilotStatusEntryData(status: string): AutopilotStatusEntryData { return { status }; }
