# runtime/validation-runner

One-shot mechanical-rule execution skeleton. It accepts only a frozen
`execute-validation-rule` command, invokes a supplied executor once, and strictly
decodes the closed mechanical report. It contains executor failures and never
retries, blocks, or constructs terminal meaning. Semantic-validator orchestration
belongs to W3.
