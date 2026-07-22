import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATOR_ADMISSION_ACTION } from "./admission.js";
export const COORDINATOR_PEER_MODES = Object.freeze([
    'legacy-anonymous-protocol-1.6',
    'negotiated-s1',
    'known-cf50-predecessor',
]);
export const COORDINATOR_SOCKET_ADMISSION_STATES = Object.freeze([
    'awaiting-handshake',
    'legacy-handshake-served',
    'negotiated-admitted',
    'negotiated-rejected',
    'closed-invalid',
]);
const SURFACE_VOCABULARY = Object.freeze({
    // Reuses existing signed admission authority; no new vocabulary/wire identity.
    'd65-current-build': 'admission-v1',
    'canonical-worktree-aliases': 'canonical-worktree-aliases-v1',
    'scoped-logical-faults': 'scoped-logical-faults-v1',
    'store-generations': 'store-generations-v1',
});
/**
 * One instance belongs to one accepted socket. It is never serialized or shared,
 * so admission authority cannot survive a close or authorize another socket.
 */
export class CoordinatorSocketPeerState {
    #state = 'awaiting-handshake';
    #negotiationPending = false;
    #grantedVocabulary = new Set();
    get state() {
        return this.#state;
    }
    get peerMode() {
        if (this.#state === 'negotiated-admitted')
            return 'negotiated-s1';
        if (this.#state === 'legacy-handshake-served' || this.#state === 'negotiated-rejected')
            return 'legacy-anonymous-protocol-1.6';
        return null;
    }
    get grantedVocabulary() {
        return this.#grantedVocabulary;
    }
    acceptRequest(action, s1Surface = null) {
        if (this.#state === 'closed-invalid')
            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator socket is closed after an invalid admission sequence');
        if (this.#state === 'awaiting-handshake') {
            if (action !== 'handshake')
                return this.#invalidate('the first socket request must be the exact legacy handshake');
            this.#state = 'legacy-handshake-served';
            return Object.freeze({ kind: 'legacy-handshake', peerMode: 'legacy-anonymous-protocol-1.6' });
        }
        if (action === 'handshake')
            return this.#invalidate('a second handshake on one coordinator socket is forbidden');
        if (this.#state === 'negotiated-rejected')
            return this.#invalidate('a socket cannot continue after signed admission rejection');
        if (action === COORDINATOR_ADMISSION_ACTION) {
            if (this.#state !== 'legacy-handshake-served' || this.#negotiationPending)
                return this.#invalidate('admission may be negotiated exactly once after the legacy handshake');
            this.#negotiationPending = true;
            return Object.freeze({ kind: 'negotiate-admission', peerMode: 'legacy-anonymous-protocol-1.6' });
        }
        if (this.#negotiationPending)
            return this.#invalidate('an operation cannot race an incomplete admission response');
        if (s1Surface !== null) {
            if (this.#state !== 'negotiated-admitted')
                return this.#invalidate(`S1-only surface ${s1Surface} requires same-socket negotiated admission`);
            const required = SURFACE_VOCABULARY[s1Surface];
            if (!this.#grantedVocabulary.has(required))
                return this.#invalidate(`S1-only surface ${s1Surface} was not granted on this socket`);
            return Object.freeze({ kind: 'negotiated-operation', peerMode: 'negotiated-s1' });
        }
        if (this.#state === 'negotiated-admitted') {
            if (!this.#grantedVocabulary.has('legacy-protocol-1.6'))
                return this.#invalidate('legacy protocol vocabulary was not granted on this socket');
            return Object.freeze({ kind: 'legacy-operation', peerMode: 'negotiated-s1' });
        }
        return Object.freeze({ kind: 'legacy-operation', peerMode: 'legacy-anonymous-protocol-1.6' });
    }
    completeAdmission(response) {
        if (this.#state !== 'legacy-handshake-served' || !this.#negotiationPending)
            this.#invalidate('admission completion has no matching same-socket negotiation');
        this.#negotiationPending = false;
        if (!response.admitted) {
            this.#state = 'negotiated-rejected';
            this.#grantedVocabulary = new Set();
            return;
        }
        this.#state = 'negotiated-admitted';
        this.#grantedVocabulary = new Set(response.granted_vocabulary);
    }
    rejectMalformedAdmission() {
        this.#invalidate('malformed admission invalidated the coordinator socket');
    }
    close() {
        this.#negotiationPending = false;
        this.#grantedVocabulary = new Set();
        this.#state = 'closed-invalid';
    }
    #invalidate(message) {
        this.close();
        throw new CoordinationRuntimeError('unauthorized-client', message);
    }
}
export function requiredVocabularyForSurface(surface) {
    return SURFACE_VOCABULARY[surface];
}
