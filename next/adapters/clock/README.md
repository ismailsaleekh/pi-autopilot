# adapters/clock

`SystemClockAdapter` normalizes `process.hrtime.bigint()` into monotonic integer
ticks from an adapter-local origin. `observe-clock` is immediate: before its
`notBeforeTick` it returns typed retry feedback and never advances time.
`waitUntil()` is the separate physical wait primitive and reports the actual
post-wait monotonic tick. It requires an injected `ClockWaiter` capability; the
adapter itself creates no timer or scheduler. Without a waiter, a future target
returns typed `clock.waiter-unavailable` feedback. Wall time, locale, and clock
adjustment never enter an observation.

The default tick is 100 ms. Tests may inject a monotonic reader and physical
waiter through the explicit construction surface; production uses Node's
monotonic clock and W3 must supply the waiter from its clock/runtime owner.
