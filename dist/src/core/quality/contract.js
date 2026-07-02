export const AUTOPILOT_PERFECT_QUALITY_RULES = [
    'Deliver the complete root-cause solution for this unit; do not ship band-aids, hacks, symptom patches, or cosmetic green status.',
    'Do not add silent fallbacks, broad catch-and-continue logic, or compatibility shims unless the accepted architecture explicitly requires them.',
    'Do not create fake-green tests, use fixture tampering, weaken assertions, skip required witnesses, or report success from launch readiness alone.',
    'Do not create deferred consumers; required docs, schema updates, validation, and integration work must be tracked in the current closure path.',
    'Implementation and fix units are not self-certifying; source-changing work needs independent validation before semantic closure.',
    'If correctness needs wider scope, protected-path access, more evidence, or an operator decision, emit BLOCKED or route adjudication instead of hiding risk.',
];
export function renderAutopilotPerfectQualityRules() {
    return AUTOPILOT_PERFECT_QUALITY_RULES.map((rule) => `- ${rule}`).join('\n');
}
export function renderAutopilotPerfectQualityParagraph() {
    return AUTOPILOT_PERFECT_QUALITY_RULES.join(' ');
}
