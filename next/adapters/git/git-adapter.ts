import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  gitIntentCapsule,
  gitObservationCapsule,
} from "../../ports/contracts/git.capsule.js";
import type { GitIntent, GitObservation } from "../../ports/contracts/git.capsule.js";
import type { GitCapture } from "../../authority/protocol/git-values.js";
import { defineCapsule } from "../../authority/protocol/schema.js";
import {
  decimalNaturalSchema,
  digestSchema,
  gitObjectIdSchema,
  gitTreeIdSchema,
} from "../../authority/protocol/identifiers.js";
import { runGit } from "./git-process.js";

export interface GitAdapterDiagnostic { readonly code: string; readonly message: string }
export type GitAdapterExecution =
  | { readonly kind: "observation"; readonly observation: GitObservation }
  | { readonly kind: "rejected"; readonly diagnostic: GitAdapterDiagnostic };

export interface GitWorkspaceLocator {
  readonly workspaceRoot: string;
  readonly pathFor: (workspaceCapability: string, workspaceId: string) => string | null;
}
export interface GitRepositoryLocator {
  readonly pathFor: (repositoryCapability: string) => string | null;
}
export interface GitAdapterOptions {
  readonly repositories: GitRepositoryLocator;
  readonly integrationRoot: string;
  readonly workspace: GitWorkspaceLocator;
  readonly maxOutputBytes: number;
  readonly publicationObserver?: (point: "before-update-ref") => void | Promise<void>;
}
export type GitAdapterCreateResult =
  | { readonly kind: "created"; readonly adapter: GitAdapter }
  | { readonly kind: "rejected"; readonly diagnostic: GitAdapterDiagnostic };

type GitObjectFormat = "sha1" | "sha256";
interface RepositoryBinding { readonly path: string; readonly format: GitObjectFormat }
type RefObservation = { readonly kind: "unborn" } | { readonly kind: "at"; readonly commit: string; readonly tree: string };

const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const AUTHOR_ENV = Object.freeze({
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_AUTHOR_EMAIL: "autopilot@invalid",
  GIT_AUTHOR_NAME: "Pi Autopilot",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_EMAIL: "autopilot@invalid",
  GIT_COMMITTER_NAME: "Pi Autopilot",
});
const digestCapsule = defineCapsule("GitCaptureDigest", digestSchema);
const decimalCapsule = defineCapsule("GitCaptureDecimal", decimalNaturalSchema);
const objectCapsule = defineCapsule("GitCaptureObject", gitObjectIdSchema);
const treeCapsule = defineCapsule("GitCaptureTree", gitTreeIdSchema);

function diagnostic(code: string, message: string): GitAdapterDiagnostic { return Object.freeze({ code, message }); }
function contractDiagnostic(code: string, message: string) { return Object.freeze({ code, message, related: Object.freeze([]) }); }
function decodeUtf8(bytes: Uint8Array): string | null { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; } }
function hash(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function canonicalBytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function below(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function validOid(value: string, format: GitObjectFormat): boolean { return OID.test(value) && value.length === (format === "sha1" ? 40 : 64); }
function revision(bytes: Uint8Array, format: GitObjectFormat): string | null { const value = decodeUtf8(bytes)?.trim() ?? ""; return validOid(value, format) ? value : null; }

function safeDecode(input: unknown): { readonly kind: "ok"; readonly value: GitIntent } | { readonly kind: "error"; readonly diagnostic: GitAdapterDiagnostic } {
  const encoded = gitIntentCapsule.encodeUnknown(input);
  if (encoded.kind === "error") return Object.freeze({ kind: "error", diagnostic: diagnostic("git.invalid-intent", encoded.error.diagnostic) });
  const decoded = gitIntentCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok" ? Object.freeze({ kind: "ok", value: decoded.value }) : Object.freeze({ kind: "error", diagnostic: diagnostic("git.invalid-intent", decoded.error.diagnostic) });
}
function capture(bytes: Uint8Array, codec: string, version: string, ids: readonly string[], max: number): GitCapture | null {
  if (bytes.byteLength > max || ids.length > 4) return null;
  const digest = digestCapsule.decode(hash(bytes));
  const length = decimalCapsule.decode(String(bytes.byteLength));
  const objectIds = ids.map((id) => objectCapsule.decode(id)).filter((value) => value.kind === "ok").map((value) => value.kind === "ok" ? value.value : objectCapsule.arbitrary.valid(0));
  if (digest.kind !== "ok" || length.kind !== "ok" || objectIds.length !== ids.length) return null;
  return Object.freeze({ byteLength: length.value, codec: codec as never, codecVersion: version as never, digest: digest.value, objectIds: Object.freeze(objectIds) });
}

export class GitAdapter {
  private constructor(private readonly options: GitAdapterOptions) {}
  public static async create(options: GitAdapterOptions): Promise<GitAdapterCreateResult> {
    try {
      if (typeof options !== "object" || options === null || typeof options.repositories?.pathFor !== "function" || typeof options.workspace?.pathFor !== "function" || typeof options.integrationRoot !== "string" || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1024) {
        return Object.freeze({ kind: "rejected", diagnostic: diagnostic("git.invalid-options", "repository/workspace resolvers and explicit capture bound are required") });
      }
      const root = resolve(options.integrationRoot);
      const status = await lstat(root);
      if (!status.isDirectory() || status.isSymbolicLink()) return Object.freeze({ kind: "rejected", diagnostic: diagnostic("git.integration-root-unsafe", "integration root must be a real directory") });
      return Object.freeze({ kind: "created", adapter: new GitAdapter(Object.freeze({ ...options, integrationRoot: root })) });
    } catch { return Object.freeze({ kind: "rejected", diagnostic: diagnostic("git.create-failed", "adapter creation failed") }); }
  }
  public async execute(input: unknown): Promise<GitAdapterExecution> {
    const decoded = safeDecode(input);
    if (decoded.kind === "error") return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    switch (decoded.value.kind) {
      case "observe-repository-ref": return this.observeRef(decoded.value);
      case "materialize-workspace": return this.materialize(decoded.value);
      case "seal-workspace": return this.seal(decoded.value);
      case "compare-roots": return this.compare(decoded.value);
      case "integrate-candidate": return this.integrate(decoded.value);
      case "publish-if-expected-head": return this.publish(decoded.value);
    }
  }
  private async repository(capability: string): Promise<RepositoryBinding | null> {
    const pathInput = this.options.repositories.pathFor(capability);
    if (pathInput === null) return null;
    const path = resolve(pathInput);
    const probe = await runGit(["rev-parse", "--git-dir"], { cwd: path, maxOutputBytes: this.options.maxOutputBytes });
    const formatProbe = await runGit(["rev-parse", "--show-object-format"], { cwd: path, maxOutputBytes: this.options.maxOutputBytes });
    const format = formatProbe.kind === "exited" && formatProbe.code === 0 ? decodeUtf8(formatProbe.stdout)?.trim() : null;
    return probe.kind === "exited" && probe.code === 0 && (format === "sha1" || format === "sha256") ? Object.freeze({ path, format }) : null;
  }
  private async commit(binding: RepositoryBinding, value: string): Promise<string | null> {
    if (!validOid(value, binding.format)) return null;
    const result = await runGit(["rev-parse", "--verify", `${value}^{commit}`], { cwd: binding.path, maxOutputBytes: this.options.maxOutputBytes });
    return result.kind === "exited" && result.code === 0 ? revision(result.stdout, binding.format) : null;
  }
  private async tree(binding: RepositoryBinding, value: string): Promise<string | null> {
    if (!validOid(value, binding.format)) return null;
    const result = await runGit(["rev-parse", "--verify", `${value}^{tree}`], { cwd: binding.path, maxOutputBytes: this.options.maxOutputBytes });
    return result.kind === "exited" && result.code === 0 ? revision(result.stdout, binding.format) : null;
  }
  private async ref(binding: RepositoryBinding, ref: string): Promise<RefObservation | null> {
    if (!REF.test(ref) || ref.includes("..") || ref.endsWith("/")) return null;
    const result = await runGit(["show-ref", "--verify", "--hash", ref], { cwd: binding.path, maxOutputBytes: this.options.maxOutputBytes });
    if (result.kind !== "exited") return null;
    if (result.code === 1 && result.stdout.byteLength === 0) return Object.freeze({ kind: "unborn" });
    const commit = result.code === 0 ? revision(result.stdout, binding.format) : null;
    const tree = commit === null ? null : await this.tree(binding, commit);
    return commit !== null && tree !== null ? Object.freeze({ kind: "at", commit, tree }) : null;
  }
  private async observeRef(intent: Extract<GitIntent, { kind: "observe-repository-ref" }>): Promise<GitAdapterExecution> {
    const repository = await this.repository(intent.inputs.repository);
    const observed = repository === null ? null : await this.ref(repository, intent.inputs.publicationRef);
    return observed === null ? this.retry(intent, "repository-ref-observed", "git.ref-unavailable", "repository/ref could not be observed") : this.observation(intent, "repository-ref-observed", Object.freeze({ kind: "ok", value: Object.freeze({ observed: observed.kind === "unborn" ? observed : Object.freeze({ kind: "at", commit: observed.commit }), publicationRef: intent.inputs.publicationRef, repository: intent.inputs.repository, tree: observed.kind === "unborn" ? null : observed.tree }) }));
  }
  private async materialize(intent: Extract<GitIntent, { kind: "materialize-workspace" }>): Promise<GitAdapterExecution> {
    const repository = await this.repository(intent.inputs.repository);
    const destinationInput = this.options.workspace.pathFor(intent.inputs.workspaceCapability, intent.inputs.workspaceId);
    if (repository === null || destinationInput === null) return this.retry(intent, "workspace-materialized", "git.capability-unbound", "repository or workspace capability is unbound");
    const destination = resolve(destinationInput);
    try { const status = await lstat(destination); if (!status.isDirectory() || status.isSymbolicLink() || (await readdir(destination)).length !== 0) return this.retry(intent, "workspace-materialized", "git.workspace-not-empty", "reservation is not an empty real directory"); } catch { return this.retry(intent, "workspace-materialized", "git.workspace-unavailable", "reservation is unavailable"); }
    const commit = await this.commit(repository, intent.inputs.baseCommit);
    const tree = commit === null ? null : await this.tree(repository, commit);
    if (commit === null || tree !== intent.inputs.baseTree) return this.retry(intent, "workspace-materialized", "git.base-mismatch", "base commit/tree mismatch");
    const clone = await runGit(["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--no-tags", "--", repository.path, destination], { cwd: dirname(destination), maxOutputBytes: this.options.maxOutputBytes });
    if (clone.kind !== "exited" || clone.code !== 0) return this.retry(intent, "workspace-materialized", "git.clone-failed", "clone failed");
    const checkout = await runGit(["checkout", "--detach", "--force", commit], { cwd: destination, maxOutputBytes: this.options.maxOutputBytes });
    return checkout.kind === "exited" && checkout.code === 0 ? this.observation(intent, "workspace-materialized", Object.freeze({ kind: "ok", value: Object.freeze({ baseCommit: commit, baseTree: tree, repository: intent.inputs.repository, workspaceId: intent.inputs.workspaceId }) })) : this.retry(intent, "workspace-materialized", "git.checkout-failed", "checkout failed");
  }
  private async seal(intent: Extract<GitIntent, { kind: "seal-workspace" }>): Promise<GitAdapterExecution> {
    const repository = await this.repository(intent.inputs.repository);
    const workspace = this.options.workspace.pathFor(intent.inputs.workspaceCapability, intent.inputs.workspaceId);
    if (repository === null || workspace === null) return this.retry(intent, "workspace-sealed", "git.capability-unbound", "capability is unbound");
    const staged = await runGit(["add", "-A", "--", "."], { cwd: workspace, maxOutputBytes: this.options.maxOutputBytes });
    const written = staged.kind === "exited" && staged.code === 0 ? await runGit(["write-tree"], { cwd: workspace, maxOutputBytes: this.options.maxOutputBytes }) : null;
    const tree = written?.kind === "exited" && written.code === 0 ? revision(written.stdout, repository.format) : null;
    if (tree === null) return this.retry(intent, "workspace-sealed", "git.seal-failed", "workspace could not be sealed");
    const bytes = canonicalBytes(Object.freeze({ format: "pi-autopilot.git-tree-capture.v2", gitTree: tree }));
    const value = capture(bytes, "codec:git-tree-capture", "version:2", [tree], this.options.maxOutputBytes);
    return value === null ? this.retry(intent, "workspace-sealed", "git.capture-bound", "seal capture exceeded bound") : this.observation(intent, "workspace-sealed", Object.freeze({ kind: "ok", value: Object.freeze({ capture: value, gitTree: tree, workspaceId: intent.inputs.workspaceId }) }));
  }
  private async compare(intent: Extract<GitIntent, { kind: "compare-roots" }>): Promise<GitAdapterExecution> {
    const repository = await this.repository(intent.inputs.repository);
    if (repository === null || await this.tree(repository, intent.inputs.leftTree) === null || await this.tree(repository, intent.inputs.rightTree) === null) return this.retry(intent, "roots-compared", "git.tree-unavailable", "tree unavailable");
    const compared = await runGit(["diff-tree", "--no-commit-id", "--root", "--raw", "-z", "-r", "-M", "--no-ext-diff", intent.inputs.leftTree, intent.inputs.rightTree], { cwd: repository.path, maxOutputBytes: this.options.maxOutputBytes });
    if (compared.kind !== "exited" || compared.code !== 0 || compared.stdoutTruncated) return this.retry(intent, "roots-compared", "git.compare-failed", "bounded diff failed");
    const diff = capture(compared.stdout, "codec:git-raw-diff", "version:2", [intent.inputs.leftTree, intent.inputs.rightTree], this.options.maxOutputBytes);
    return diff === null ? this.retry(intent, "roots-compared", "git.capture-bound", "diff exceeded bound") : this.observation(intent, "roots-compared", Object.freeze({ kind: "ok", value: Object.freeze({ diff, equal: intent.inputs.leftTree === intent.inputs.rightTree, leftTree: intent.inputs.leftTree, rightTree: intent.inputs.rightTree }) }));
  }
  private async integrate(intent: Extract<GitIntent, { kind: "integrate-candidate" }>): Promise<GitAdapterExecution> {
    const repository = await this.repository(intent.inputs.repository);
    if (repository === null) return this.retry(intent, "candidate-integrated", "git.repository-unbound", "repository capability unbound");
    const base = await this.commit(repository, intent.inputs.baseCommit);
    const candidate = await this.commit(repository, intent.inputs.candidateCommit);
    if (base === null || candidate === null || await this.tree(repository, base) !== intent.inputs.baseTree || await this.tree(repository, candidate) !== intent.inputs.candidateTree) return this.retry(intent, "candidate-integrated", "git.integration-precondition", "commit/tree binding differs");
    const directory = resolve(this.options.integrationRoot, `integration-${intent.actionId.slice(14)}`);
    if (!below(this.options.integrationRoot, directory)) return this.retry(intent, "candidate-integrated", "git.integration-path", "integration path unsafe");
    try { await rm(directory, { recursive: true, force: true }); } catch { return this.retry(intent, "candidate-integrated", "git.integration-clean", "integration path unavailable"); }
    const clone = await runGit(["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--no-tags", "--", repository.path, directory], { cwd: this.options.integrationRoot, maxOutputBytes: this.options.maxOutputBytes });
    if (clone.kind !== "exited" || clone.code !== 0) return this.retry(intent, "candidate-integrated", "git.integration-clone", "clone failed");
    await runGit(["checkout", "--detach", "--force", base], { cwd: directory, maxOutputBytes: this.options.maxOutputBytes });
    const merge = await runGit(["merge", "--no-ff", "--no-edit", candidate], { cwd: directory, extraEnvironment: AUTHOR_ENV, maxOutputBytes: this.options.maxOutputBytes });
    if (merge.kind !== "exited" || merge.code !== 0) {
      const conflicts = await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: directory, maxOutputBytes: this.options.maxOutputBytes });
      const conflict = capture(conflicts.kind === "exited" ? conflicts.stdout : new Uint8Array(), "codec:git-conflict", "version:2", [base, candidate], this.options.maxOutputBytes);
      return conflict === null ? this.retry(intent, "candidate-integrated", "git.conflict-bound", "conflict capture exceeded bound") : this.observation(intent, "candidate-integrated", Object.freeze({ kind: "ok", value: Object.freeze({ candidateId: intent.inputs.candidateId, conflict, kind: "conflict" }) }));
    }
    const headOut = await runGit(["rev-parse", "HEAD"], { cwd: directory, maxOutputBytes: this.options.maxOutputBytes });
    const treeOut = await runGit(["rev-parse", "HEAD^{tree}"], { cwd: directory, maxOutputBytes: this.options.maxOutputBytes });
    const commit = headOut.kind === "exited" ? revision(headOut.stdout, repository.format) : null;
    const tree = treeOut.kind === "exited" ? revision(treeOut.stdout, repository.format) : null;
    if (commit === null || tree === null) return this.retry(intent, "candidate-integrated", "git.integration-result", "integrated identity unavailable");
    const manifest = capture(canonicalBytes({ base, candidate, commit, tree }), "codec:git-integration-manifest", "version:2", [base, candidate, commit, tree], this.options.maxOutputBytes);
    const diff = capture(new Uint8Array(), "codec:git-raw-diff", "version:2", [base, commit], this.options.maxOutputBytes);
    return manifest === null || diff === null ? this.retry(intent, "candidate-integrated", "git.capture-bound", "integration capture exceeded bound") : this.observation(intent, "candidate-integrated", Object.freeze({ kind: "ok", value: Object.freeze({ candidateId: intent.inputs.candidateId, commit, conflict: null, diff, kind: "integrated", manifest, tree }) }));
  }
  private async publish(intent: Extract<GitIntent, { kind: "publish-if-expected-head" }>): Promise<GitAdapterExecution> {
    const repository = await this.repository(intent.inputs.repository);
    if (repository === null) return this.retry(intent, "head-publication-observed", "git.repository-unbound", "repository capability unbound");
    const desired = await this.commit(repository, intent.inputs.desiredHead);
    const desiredTree = desired === null ? null : await this.tree(repository, desired);
    if (desired === null || desiredTree !== intent.preconditions.candidateTree) return this.retry(intent, "head-publication-observed", "git.publish-tree", "desired commit/tree mismatch");
    const before = await this.ref(repository, intent.inputs.publicationRef);
    if (before === null) return this.retry(intent, "head-publication-observed", "git.ref-unavailable", "publication ref unavailable");
    if (before.kind === "at" && before.commit === desired) return this.publication(intent, desiredTree, desired, "desired-head");
    const matches = intent.inputs.expected.kind === "unborn" ? before.kind === "unborn" : before.kind === "at" && before.commit === intent.inputs.expected.commit;
    if (!matches) return this.publication(intent, desiredTree, before.kind === "at" ? before.commit : null, "head-moved");
    if (this.options.publicationObserver !== undefined) await this.options.publicationObserver("before-update-ref");
    const old = intent.inputs.expected.kind === "unborn" ? "0".repeat(repository.format === "sha1" ? 40 : 64) : intent.inputs.expected.commit;
    await runGit(["update-ref", intent.inputs.publicationRef, desired, old], { cwd: repository.path, maxOutputBytes: this.options.maxOutputBytes });
    const after = await this.ref(repository, intent.inputs.publicationRef);
    return after?.kind === "at" && after.commit === desired ? this.publication(intent, desiredTree, desired, "desired-head") : this.publication(intent, desiredTree, after?.kind === "at" ? after.commit : null, "head-moved");
  }
  private publication(intent: Extract<GitIntent, { kind: "publish-if-expected-head" }>, tree: string, head: string | null, status: "desired-head" | "head-moved"): GitAdapterExecution {
    const gitTree = treeCapsule.decode(tree);
    return gitTree.kind !== "ok" ? this.retry(intent, "head-publication-observed", "git.tree-invalid", "Git tree identity invalid") : this.observation(intent, "head-publication-observed", Object.freeze({ kind: "ok", value: Object.freeze({ desiredHead: intent.inputs.desiredHead, gitTree: gitTree.value, observedHead: head, publicationId: intent.inputs.publicationId, status }) }));
  }
  private retry(intent: GitIntent, kind: GitObservation["kind"], code: string, message: string): GitAdapterExecution { return this.observation(intent, kind, Object.freeze({ kind: "retry", diagnostic: contractDiagnostic(code, message) })); }
  private observation(intent: GitIntent, kind: GitObservation["kind"], result: unknown): GitAdapterExecution {
    const encoded = gitObservationCapsule.encodeUnknown(Object.freeze({ actionId: intent.actionId, kind, result, runId: intent.runId }));
    if (encoded.kind === "error") return Object.freeze({ kind: "rejected", diagnostic: diagnostic("git.invalid-observation", encoded.error.diagnostic) });
    const decoded = gitObservationCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? Object.freeze({ kind: "observation", observation: decoded.value }) : Object.freeze({ kind: "rejected", diagnostic: diagnostic("git.invalid-observation", decoded.error.diagnostic) });
  }
}

export const gitIntentHandlers = Object.freeze({
  "compare-roots": true,
  "integrate-candidate": true,
  "materialize-workspace": true,
  "observe-repository-ref": true,
  "publish-if-expected-head": true,
  "seal-workspace": true,
}) satisfies Readonly<Record<GitIntent["kind"], true>>;
