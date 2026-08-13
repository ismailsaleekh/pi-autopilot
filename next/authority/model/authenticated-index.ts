import {
  addDecimalNatural,
  compareDecimalNatural,
  decimalNatural,
  decimalNaturalSchema,
  indexRootSchema,
} from "../protocol/identifiers.js";
import type {
  DecimalNatural,
  Digest,
  IndexRoot,
} from "../protocol/identifiers.js";
import { defineCapsule } from "../protocol/schema.js";
import {
  indexKeyDigest,
  indexMutationDigest,
  indexValueDigest,
  sparseEmptyLeafDigest,
  sparseNodeDigest,
  sparsePresentLeafDigest,
} from "../protocol/state-index.capsule.js";
import type {
  IndexMutation,
  IndexName,
  IndexValue,
  ResolvedIndexPage,
  SparseWitness,
} from "../protocol/state-index.capsule.js";

export const MAX_HOT_INDEX_VALUES = 32;
export const SPARSE_PROOF_DEPTH = 256;

export interface HotIndexValue {
  readonly key: Digest;
  readonly value: IndexValue;
}

export interface AuthenticatedIndexState {
  readonly name: IndexName;
  readonly root: IndexRoot;
  readonly count: DecimalNatural;
  readonly hotComplete: boolean;
  readonly hot: readonly HotIndexValue[];
}

export type IndexLookup =
  | { readonly kind: "proved"; readonly value: IndexValue | null; readonly witness: SparseWitness }
  | { readonly kind: "unproven"; readonly diagnostic: string };

export type MutationPreparation =
  | { readonly kind: "prepared"; readonly mutation: IndexMutation; readonly prior: IndexValue | null }
  | { readonly kind: "unproven"; readonly diagnostic: string };

export type MutationApplication =
  | { readonly kind: "applied"; readonly state: AuthenticatedIndexState }
  | { readonly kind: "rejected"; readonly diagnostic: string };

interface DigestEntry {
  readonly key: Digest;
  readonly valueDigest: Digest;
}

const indexRootCapsule = defineCapsule("AuthorityIndexRoot", indexRootSchema);
const decimalValueCapsule = defineCapsule("AuthorityDecimalValue", decimalNaturalSchema);

function knownDecimal(value: string, seed: number): DecimalNatural {
  const decoded = decimalValueCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : decimalValueCapsule.arbitrary.valid(seed);
}

const ZERO = knownDecimal("0", 0);
const ONE = knownDecimal("1", 1);
const MAX_HOT_COUNT = knownDecimal(String(MAX_HOT_INDEX_VALUES), MAX_HOT_INDEX_VALUES);
const EMPTY_LEAF = sparseEmptyLeafDigest();

function rootFromDigest(value: Digest): IndexRoot | null {
  const decoded = indexRootCapsule.decode(value);
  return decoded.kind === "ok" ? decoded.value : null;
}

function combine(left: Digest, right: Digest): Digest {
  return sparseNodeDigest(left, right);
}

function presentLeaf(key: Digest, valueDigest: Digest): Digest {
  return sparsePresentLeafDigest(key, valueDigest);
}

function defaultHashes(): readonly Digest[] {
  const output: Digest[] = [EMPTY_LEAF];
  for (let level = 0; level < SPARSE_PROOF_DEPTH; level += 1) {
    const prior = output[level];
    if (prior !== undefined) {
      output.push(combine(prior, prior));
    }
  }
  return Object.freeze(output);
}

const DEFAULT_HASHES = defaultHashes();
const EMPTY_ROOT = rootFromDigest(DEFAULT_HASHES[SPARSE_PROOF_DEPTH] ?? EMPTY_LEAF);

function keyBits(key: Digest): string {
  let output = "";
  const hex = key.slice(7);
  for (let index = 0; index < hex.length; index += 1) {
    const digit = hex.charCodeAt(index);
    const value = digit >= 48 && digit <= 57 ? digit - 48 : digit - 87;
    output += (value & 8) === 0 ? "0" : "1";
    output += (value & 4) === 0 ? "0" : "1";
    output += (value & 2) === 0 ? "0" : "1";
    output += (value & 1) === 0 ? "0" : "1";
  }
  return output;
}

function levelsFor(entries: readonly DigestEntry[]): readonly ReadonlyMap<string, Digest>[] {
  const levels: Map<string, Digest>[] = [];
  const leaves = new Map<string, Digest>();
  for (const entry of entries) {
    leaves.set(keyBits(entry.key), presentLeaf(entry.key, entry.valueDigest));
  }
  levels.push(leaves);
  let current = leaves;
  for (let level = 0; level < SPARSE_PROOF_DEPTH; level += 1) {
    const parents = new Map<string, Digest>();
    const prefixes = new Set<string>();
    for (const key of current.keys()) {
      prefixes.add(key.slice(0, -1));
    }
    const empty = DEFAULT_HASHES[level] ?? EMPTY_LEAF;
    for (const prefix of prefixes) {
      const left = current.get(`${prefix}0`) ?? empty;
      const right = current.get(`${prefix}1`) ?? empty;
      parents.set(prefix, combine(left, right));
    }
    levels.push(parents);
    current = parents;
  }
  return Object.freeze(levels);
}

function witnessFor(entries: readonly DigestEntry[], key: Digest, value: IndexValue | null): SparseWitness | null {
  const levels = levelsFor(entries);
  const bits = keyBits(key);
  const siblings: Digest[] = [];
  for (let level = 0; level < SPARSE_PROOF_DEPTH; level += 1) {
    const prefixLength = SPARSE_PROOF_DEPTH - level;
    const prefix = bits.slice(0, prefixLength);
    const parent = prefix.slice(0, -1);
    const bit = prefix.endsWith("1") ? "1" : "0";
    const siblingKey = `${parent}${bit === "1" ? "0" : "1"}`;
    const levelMap = levels[level];
    const empty = DEFAULT_HASHES[level] ?? EMPTY_LEAF;
    siblings.push(levelMap?.get(siblingKey) ?? empty);
  }
  return Object.freeze({ key, siblings: Object.freeze(siblings), value });
}

export { indexMutationDigest, indexValueDigest };

export function indexKey(name: IndexName, identity: string): Digest {
  return indexKeyDigest(name, identity);
}

export function sparseRoot(
  key: Digest,
  valueDigest: Digest | null,
  siblings: readonly Digest[],
): IndexRoot | null {
  if (siblings.length !== SPARSE_PROOF_DEPTH) {
    return null;
  }
  const bits = keyBits(key);
  let current = valueDigest === null ? EMPTY_LEAF : presentLeaf(key, valueDigest);
  for (let level = 0; level < SPARSE_PROOF_DEPTH; level += 1) {
    const sibling = siblings[level];
    if (sibling === undefined) {
      return null;
    }
    const bit = bits.charAt(SPARSE_PROOF_DEPTH - level - 1);
    current = bit === "1" ? combine(sibling, current) : combine(current, sibling);
  }
  return rootFromDigest(current);
}

export function initialAuthenticatedIndex(name: IndexName): AuthenticatedIndexState {
  const root = EMPTY_ROOT ?? indexRootCapsule.arbitrary.valid(0);
  return Object.freeze({ name, root, count: ZERO, hotComplete: true, hot: Object.freeze([]) });
}

function sameIndexValue(left: IndexValue | null, right: IndexValue | null): boolean {
  return left === null || right === null
    ? left === right
    : indexValueDigest(left) === indexValueDigest(right);
}

function witnessRoot(witness: SparseWitness): IndexRoot | null {
  return sparseRoot(
    witness.key,
    witness.value === null ? null : indexValueDigest(witness.value),
    witness.siblings,
  );
}

export function lookupIndex(
  state: AuthenticatedIndexState,
  key: Digest,
  pages: readonly ResolvedIndexPage[],
): IndexLookup {
  const hot = state.hot.find((entry) => entry.key === key);
  if (hot !== undefined && state.hotComplete) {
    const entries = state.hot.map((entry) => Object.freeze({
      key: entry.key,
      valueDigest: indexValueDigest(entry.value),
    }));
    const witness = witnessFor(entries, key, hot.value);
    if (witness !== null && witnessRoot(witness) === state.root) {
      return Object.freeze({ kind: "proved", value: hot.value, witness });
    }
  }
  if (state.hotComplete) {
    const entries = state.hot.map((entry) => Object.freeze({
      key: entry.key,
      valueDigest: indexValueDigest(entry.value),
    }));
    const witness = witnessFor(entries, key, null);
    if (witness !== null && witnessRoot(witness) === state.root) {
      return Object.freeze({ kind: "proved", value: null, witness });
    }
  }
  for (const page of pages) {
    if (page.index !== state.name || page.root !== state.root || page.witnesses.length > MAX_HOT_INDEX_VALUES) {
      continue;
    }
    const witness = page.witnesses.find((entry) => entry.key === key);
    if (witness !== undefined && witnessRoot(witness) === state.root) {
      return Object.freeze({ kind: "proved", value: witness.value, witness });
    }
  }
  return Object.freeze({
    kind: "unproven",
    diagnostic: `missing authenticated ${state.name} page for key ${key}; absence is unproven`,
  });
}

export function prepareIndexMutation(
  state: AuthenticatedIndexState,
  key: Digest,
  next: IndexValue | null,
  pages: readonly ResolvedIndexPage[],
): MutationPreparation {
  const lookup = lookupIndex(state, key, pages);
  if (lookup.kind !== "proved") {
    return lookup;
  }
  const mutation: IndexMutation = Object.freeze({
    index: state.name,
    key,
    nextValueDigest: next === null ? null : indexValueDigest(next),
    priorValueDigest: lookup.value === null ? null : indexValueDigest(lookup.value),
    siblings: lookup.witness.siblings,
  });
  return Object.freeze({ kind: "prepared", mutation, prior: lookup.value });
}

function subtractOne(value: DecimalNatural): DecimalNatural | null {
  if (compareDecimalNatural(value, ZERO) === 0) {
    return null;
  }
  const digits = value.split("");
  let borrow = 1;
  for (let index = digits.length - 1; index >= 0 && borrow === 1; index -= 1) {
    const digit = digits[index];
    const numeric = digit === undefined ? 0 : digit.charCodeAt(0) - 48;
    if (numeric === 0) {
      digits[index] = "9";
    } else {
      digits[index] = String(numeric - 1);
      borrow = 0;
    }
  }
  while (digits.length > 1 && digits[0] === "0") {
    digits.shift();
  }
  return decimalNatural(digits.join(""));
}

export function applyIndexMutation(
  state: AuthenticatedIndexState,
  mutation: IndexMutation,
  prior: IndexValue | null,
  next: IndexValue | null,
): MutationApplication {
  if (mutation.index !== state.name || mutation.siblings.length !== SPARSE_PROOF_DEPTH) {
    return Object.freeze({ kind: "rejected", diagnostic: "index mutation names the wrong index or proof depth" });
  }
  const priorDigest = prior === null ? null : indexValueDigest(prior);
  const nextDigest = next === null ? null : indexValueDigest(next);
  if (mutation.priorValueDigest !== priorDigest || mutation.nextValueDigest !== nextDigest) {
    return Object.freeze({ kind: "rejected", diagnostic: "index mutation value digests do not match semantic values" });
  }
  const oldRoot = sparseRoot(mutation.key, priorDigest, mutation.siblings);
  const newRoot = sparseRoot(mutation.key, nextDigest, mutation.siblings);
  if (oldRoot !== state.root || newRoot === null) {
    return Object.freeze({ kind: "rejected", diagnostic: "index mutation proof does not bind the current root" });
  }
  let count = state.count;
  if (prior === null && next !== null) {
    count = addDecimalNatural(count, ONE);
  } else if (prior !== null && next === null) {
    const lowered = subtractOne(count);
    if (lowered === null) {
      return Object.freeze({ kind: "rejected", diagnostic: "index count cannot underflow" });
    }
    count = lowered;
  }
  const retained = state.hot.filter((entry) => entry.key !== mutation.key);
  if (next !== null) {
    retained.push(Object.freeze({ key: mutation.key, value: next }));
  }
  retained.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const complete = compareDecimalNatural(count, MAX_HOT_COUNT) <= 0;
  const hot = complete ? retained : retained.slice(Math.max(0, retained.length - MAX_HOT_INDEX_VALUES));
  return Object.freeze({
    kind: "applied",
    state: Object.freeze({
      name: state.name,
      root: newRoot,
      count,
      hotComplete: complete,
      hot: Object.freeze(hot),
    }),
  });
}

export function indexValues(
  state: AuthenticatedIndexState,
  kind: IndexValue["kind"],
): readonly IndexValue[] | null {
  if (!state.hotComplete) {
    return null;
  }
  return Object.freeze(state.hot
    .map((entry) => entry.value)
    .filter((value) => value.kind === kind));
}

export function valuesEqual(left: IndexValue | null, right: IndexValue | null): boolean {
  return sameIndexValue(left, right);
}
