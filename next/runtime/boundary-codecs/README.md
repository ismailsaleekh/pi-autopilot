# runtime/boundary-codecs

Total host-value capture and frozen-capsule decoding. External values are copied
iteratively into bounded, prototype-free inert JSON; accessors are never invoked,
and throwing proxies, revoked proxies, cycles, unsupported JavaScript values,
excessive depth, node count, property count, and canonical byte size return typed
feedback. Typed values are produced only by W0 capsule canonical round-trips.
