import type {
  PiProbeDeadline,
  PiProbeDeadlineResult,
} from "../../../adapters/pi-session/index.js";

/** Test/real-suite platform capability; production composition belongs to W3. */
export class NodeProbeDeadline implements PiProbeDeadline {
  #active = 0;

  public activeCount(): number {
    return this.#active;
  }

  public race<Value>(
    operation: Promise<Value>,
    timeoutMilliseconds: number,
  ): Promise<PiProbeDeadlineResult<Value>> {
    this.#active += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: PiProbeDeadlineResult<Value>): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.#active -= 1;
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.#active -= 1;
        reject(error);
      };
      const timer = setTimeout(() => {
        finish(Object.freeze({ kind: "time-bound" }));
      }, timeoutMilliseconds);
      void operation.then(
        (value) => finish(Object.freeze({ kind: "completed", value })),
        fail,
      );
    });
  }
}
