declare module 'node:crypto' {
  export interface KeyObject {
    readonly asymmetricKeyType?: string;
    export(options: { readonly format: 'der'; readonly type: 'spki' }): Uint8Array;
    export(options: { readonly format: 'pem'; readonly type: 'pkcs8' }): string | Uint8Array;
  }
  export function createPublicKey(input: {
    readonly key: Uint8Array;
    readonly format: 'der';
    readonly type: 'spki';
  }): KeyObject;
  export function createPrivateKey(key: string): KeyObject;
  export function verify(
    algorithm: null,
    data: Uint8Array,
    key: KeyObject,
    signature: Uint8Array,
  ): boolean;
  export function sign(algorithm: null, data: Uint8Array, key: KeyObject): Uint8Array;
  export function generateKeyPairSync(type: 'ed25519'): {
    readonly publicKey: KeyObject;
    readonly privateKey: KeyObject;
  };
}
