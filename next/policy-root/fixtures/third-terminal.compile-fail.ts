import type { TerminalOutcome } from "../../authority/protocol/terminal-outcome.capsule.js";

const forbiddenThirdOutcome: TerminalOutcome = {
  kind: "blocked",
  diagnostic: "a third semantic terminal must not compile",
};

void forbiddenThirdOutcome;
