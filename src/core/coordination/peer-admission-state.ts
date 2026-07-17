import { CoordinationRuntimeError } from './failures.ts';
import { COORDINATOR_ADMISSION_ACTION, type CoordinatorAdmissionResponse, type CoordinatorAdmissionVocabulary } from './admission.ts';
import type { CoordinatorMutationAction, CoordinatorQueryAction } from './types.ts';

export const COORDINATOR_PEER_MODES = Object.freeze([
  'legacy-anonymous-protocol-1.6',
  'negotiated-s1',
  'known-cf50-predecessor',
] as const);

export type CoordinatorPeerMode = (typeof COORDINATOR_PEER_MODES)[number];

export const COORDINATOR_SOCKET_ADMISSION_STATES = Object.freeze([
  'awaiting-handshake',
  'legacy-handshake-served',
  'negotiated-admitted',
  'negotiated-rejected',
  'closed-invalid',
] as const);

export type CoordinatorSocketAdmissionState = (typeof COORDINATOR_SOCKET_ADMISSION_STATES)[number];
export type CoordinatorLegacyAction = CoordinatorQueryAction | CoordinatorMutationAction;

export type CoordinatorSocketRequestDisposition =
  | { readonly kind: 'legacy-handshake'; readonly peerMode: 'legacy-anonymous-protocol-1.6' }
  | { readonly kind: 'legacy-operation'; readonly peerMode: 'legacy-anonymous-protocol-1.6' | 'negotiated-s1' }
  | { readonly kind: 'negotiate-admission'; readonly peerMode: 'legacy-anonymous-protocol-1.6' }
  | { readonly kind: 'negotiated-operation'; readonly peerMode: 'negotiated-s1' };

export type CoordinatorS1Surface =
  | 'canonical-worktree-aliases'
  | 'scoped-logical-faults'
  | 'store-generations';

const SURFACE_VOCABULARY: Readonly<Record<CoordinatorS1Surface, CoordinatorAdmissionVocabulary>> = Object.freeze({
  'canonical-worktree-aliases': 'canonical-worktree-aliases-v1',
  'scoped-logical-faults': 'scoped-logical-faults-v1',
  'store-generations': 'store-generations-v1',
});

/**
 * One instance belongs to one accepted socket. It is never serialized or shared,
 * so admission authority cannot survive a close or authorize another socket.
 */
export class CoordinatorSocketPeerState {
  #state: CoordinatorSocketAdmissionState = 'awaiting-handshake';
  #negotiationPending = false;
  #grantedVocabulary: ReadonlySet<CoordinatorAdmissionVocabulary> = new Set();

  get state(): CoordinatorSocketAdmissionState {
    return this.#state;
  }

  get peerMode(): 'legacy-anonymous-protocol-1.6' | 'negotiated-s1' | null {
    if (this.#state === 'negotiated-admitted') return 'negotiated-s1';
    if (this.#state === 'legacy-handshake-served' || this.#state === 'negotiated-rejected') return 'legacy-anonymous-protocol-1.6';
    return null;
  }

  get grantedVocabulary(): ReadonlySet<CoordinatorAdmissionVocabulary> {
    return this.#grantedVocabulary;
  }

  acceptRequest(action: string, s1Surface: CoordinatorS1Surface | null = null): CoordinatorSocketRequestDisposition {
    if (this.#state === 'closed-invalid') throw new CoordinationRuntimeError('unauthorized-client', 'coordinator socket is closed after an invalid admission sequence');
    if (this.#state === 'awaiting-handshake') {
      if (action !== 'handshake') return this.#invalidate('the first socket request must be the exact legacy handshake');
      this.#state = 'legacy-handshake-served';
      return Object.freeze({ kind: 'legacy-handshake', peerMode: 'legacy-anonymous-protocol-1.6' });
    }
    if (action === 'handshake') return this.#invalidate('a second handshake on one coordinator socket is forbidden');
    if (this.#state === 'negotiated-rejected') return this.#invalidate('a socket cannot continue after signed admission rejection');
    if (action === COORDINATOR_ADMISSION_ACTION) {
      if (this.#state !== 'legacy-handshake-served' || this.#negotiationPending) return this.#invalidate('admission may be negotiated exactly once after the legacy handshake');
      this.#negotiationPending = true;
      return Object.freeze({ kind: 'negotiate-admission', peerMode: 'legacy-anonymous-protocol-1.6' });
    }
    if (this.#negotiationPending) return this.#invalidate('an operation cannot race an incomplete admission response');
    if (s1Surface !== null) {
      if (this.#state !== 'negotiated-admitted') return this.#invalidate(`S1-only surface ${s1Surface} requires same-socket negotiated admission`);
      const required = SURFACE_VOCABULARY[s1Surface];
      if (!this.#grantedVocabulary.has(required)) return this.#invalidate(`S1-only surface ${s1Surface} was not granted on this socket`);
      return Object.freeze({ kind: 'negotiated-operation', peerMode: 'negotiated-s1' });
    }
    if (this.#state === 'negotiated-admitted') {
      if (!this.#grantedVocabulary.has('legacy-protocol-1.6')) return this.#invalidate('legacy protocol vocabulary was not granted on this socket');
      return Object.freeze({ kind: 'legacy-operation', peerMode: 'negotiated-s1' });
    }
    return Object.freeze({ kind: 'legacy-operation', peerMode: 'legacy-anonymous-protocol-1.6' });
  }

  completeAdmission(response: CoordinatorAdmissionResponse): void {
    if (this.#state !== 'legacy-handshake-served' || !this.#negotiationPending) this.#invalidate('admission completion has no matching same-socket negotiation');
    this.#negotiationPending = false;
    if (!response.admitted) {
      this.#state = 'negotiated-rejected';
      this.#grantedVocabulary = new Set();
      return;
    }
    this.#state = 'negotiated-admitted';
    this.#grantedVocabulary = new Set(response.granted_vocabulary);
  }

  rejectMalformedAdmission(): void {
    this.#invalidate('malformed admission invalidated the coordinator socket');
  }

  close(): void {
    this.#negotiationPending = false;
    this.#grantedVocabulary = new Set();
    this.#state = 'closed-invalid';
  }

  #invalidate(message: string): never {
    this.close();
    throw new CoordinationRuntimeError('unauthorized-client', message);
  }
}

export function requiredVocabularyForSurface(surface: CoordinatorS1Surface): CoordinatorAdmissionVocabulary {
  return SURFACE_VOCABULARY[surface];
}
