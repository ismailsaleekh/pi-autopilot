import { canonicalEncodeUnknown } from "../../authority/protocol/schema.js";
import { PORT_LAW_VECTORS } from "../../ports/laws/vectors.js";
import { SimLawDriver } from "./law-driver.js";
import { bytesHex } from "./values.js";

const seedInput = Number(process.argv[2]);
const seed = Number.isFinite(seedInput) ? Math.trunc(seedInput) : 0;
const outputs: unknown[] = [];
for (let index = 0; index < PORT_LAW_VECTORS.length; index += 1) {
  const vector = PORT_LAW_VECTORS[index];
  if (vector !== undefined) {
    const driver = new SimLawDriver(seed + index);
    const result = await vector.replay(driver);
    outputs.push(Object.freeze({
      id: vector.id,
      result,
      trace: bytesHex(driver.world.trace.canonicalBytes()),
    }));
  }
}
process.stdout.write(`${bytesHex(canonicalEncodeUnknown(Object.freeze(outputs)))}\n`);
