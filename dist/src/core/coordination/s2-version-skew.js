import { COORDINATOR_API_SCHEMA_VERSION, COORDINATOR_IMPLEMENTATION_BUILD, COORDINATOR_LEGACY_FACADE_BUILD, COORDINATOR_PACKAGE_VERSION, COORDINATOR_STORE_SCHEMA_VERSION, COORDINATOR_WIRE_LINEAGE, } from "./runtime-constants.js";
export const S2_RELEASE_SKEW_FIXTURE_SCHEMA_VERSION = 'autopilot.s2_release_skew_fixture.v1';
export const S2_RELEASE_SKEW_LANE = 's2-c';
export const S2_PREVIOUS_RELEASE_VERSION = '1.1.8';
export const S2_PREVIOUS_RELEASE_IMPLEMENTATION_BUILD = '1.1.8-cf50';
export const S2_PREVIOUS_RELEASE_WIRE_PROTOCOL_VERSION = '1.6';
export const S2_PREVIOUS_RELEASE_API_SCHEMA_VERSION = 12;
export const S2_PREVIOUS_RELEASE_FIXTURE_MANIFEST = '../cf50/manifest.json';
export const S2_PREVIOUS_RELEASE_TARBALL = '../cf50/pi-autopilot-1.1.8-cf50.tgz';
export const S2_PREVIOUS_RELEASE_TARBALL_SIZE_BYTES = 1_090_668;
export const S2_PREVIOUS_RELEASE_TARBALL_SHA256 = 'sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7';
export const S2_RELEASE_SKEW_REQUIRED_JOURNEYS = [
    'previous-client-to-current-coordinator',
    'current-client-to-previous-coordinator',
    'attach-heartbeat-idempotent-replay',
    'natural-restart-both-directions',
    'mixed-build-election',
];
function jsonRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`${label} must be a JSON object`);
    return value;
}
function requireExactFields(record, fields, label) {
    const actual = Object.keys(record).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
        throw new Error(`${label} field set mismatch: ${actual.join(',')}`);
}
function exactString(record, field, expected, label) {
    const value = record[field];
    if (value !== expected)
        throw new Error(`${label} ${field} mismatch: expected ${expected}, observed ${String(value)}`);
    return expected;
}
function exactNumber(record, field, expected, label) {
    const value = record[field];
    if (value !== expected)
        throw new Error(`${label} ${field} mismatch: expected ${String(expected)}, observed ${String(value)}`);
    return expected;
}
function exactJourneys(record, label) {
    const value = record['required_journeys'];
    if (!Array.isArray(value))
        throw new Error(`${label} required_journeys must be an array`);
    const observed = [];
    for (const item of value) {
        if (typeof item !== 'string')
            throw new Error(`${label} required_journeys entries must be strings`);
        observed.push(item);
    }
    const expected = [...S2_RELEASE_SKEW_REQUIRED_JOURNEYS];
    if (observed.length !== expected.length || observed.some((journey, index) => journey !== expected[index]))
        throw new Error(`${label} required_journeys mismatch: ${observed.join(',')}`);
    return S2_RELEASE_SKEW_REQUIRED_JOURNEYS;
}
export function parseS2ReleaseSkewFixtureManifest(value) {
    const record = jsonRecord(value, 'S2 release skew fixture manifest');
    requireExactFields(record, [
        'current_api_schema_version',
        'current_implementation_build',
        'current_legacy_facade_build',
        'current_package_version',
        'current_store_schema_version',
        'current_wire_lineage',
        'lane',
        'package',
        'previous_api_schema_version',
        'previous_fixture_manifest',
        'previous_implementation_build',
        'previous_tarball',
        'previous_tarball_sha256',
        'previous_tarball_size_bytes',
        'previous_version',
        'previous_wire_protocol_version',
        'required_journeys',
        'schema_version',
    ], 'S2 release skew fixture manifest');
    return {
        schema_version: exactString(record, 'schema_version', S2_RELEASE_SKEW_FIXTURE_SCHEMA_VERSION, 'S2 release skew fixture manifest'),
        lane: exactString(record, 'lane', S2_RELEASE_SKEW_LANE, 'S2 release skew fixture manifest'),
        package: exactString(record, 'package', 'pi-autopilot', 'S2 release skew fixture manifest'),
        current_package_version: exactString(record, 'current_package_version', COORDINATOR_PACKAGE_VERSION, 'S2 release skew fixture manifest'),
        current_implementation_build: exactString(record, 'current_implementation_build', COORDINATOR_IMPLEMENTATION_BUILD, 'S2 release skew fixture manifest'),
        current_wire_lineage: exactString(record, 'current_wire_lineage', COORDINATOR_WIRE_LINEAGE, 'S2 release skew fixture manifest'),
        current_api_schema_version: exactNumber(record, 'current_api_schema_version', COORDINATOR_API_SCHEMA_VERSION, 'S2 release skew fixture manifest'),
        current_store_schema_version: exactNumber(record, 'current_store_schema_version', COORDINATOR_STORE_SCHEMA_VERSION, 'S2 release skew fixture manifest'),
        current_legacy_facade_build: exactString(record, 'current_legacy_facade_build', COORDINATOR_LEGACY_FACADE_BUILD, 'S2 release skew fixture manifest'),
        previous_version: exactString(record, 'previous_version', S2_PREVIOUS_RELEASE_VERSION, 'S2 release skew fixture manifest'),
        previous_implementation_build: exactString(record, 'previous_implementation_build', S2_PREVIOUS_RELEASE_IMPLEMENTATION_BUILD, 'S2 release skew fixture manifest'),
        previous_wire_protocol_version: exactString(record, 'previous_wire_protocol_version', S2_PREVIOUS_RELEASE_WIRE_PROTOCOL_VERSION, 'S2 release skew fixture manifest'),
        previous_api_schema_version: exactNumber(record, 'previous_api_schema_version', S2_PREVIOUS_RELEASE_API_SCHEMA_VERSION, 'S2 release skew fixture manifest'),
        previous_fixture_manifest: exactString(record, 'previous_fixture_manifest', S2_PREVIOUS_RELEASE_FIXTURE_MANIFEST, 'S2 release skew fixture manifest'),
        previous_tarball: exactString(record, 'previous_tarball', S2_PREVIOUS_RELEASE_TARBALL, 'S2 release skew fixture manifest'),
        previous_tarball_size_bytes: exactNumber(record, 'previous_tarball_size_bytes', S2_PREVIOUS_RELEASE_TARBALL_SIZE_BYTES, 'S2 release skew fixture manifest'),
        previous_tarball_sha256: exactString(record, 'previous_tarball_sha256', S2_PREVIOUS_RELEASE_TARBALL_SHA256, 'S2 release skew fixture manifest'),
        required_journeys: exactJourneys(record, 'S2 release skew fixture manifest'),
    };
}
