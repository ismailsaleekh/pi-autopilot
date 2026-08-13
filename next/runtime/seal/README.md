# runtime/seal

Atomic submission capture. A hostile request is decoded, its workspace directory
is passed exactly once to CAS `captureTree`, and only the immutable returned root
is bound into `submission-ready`. Content is not validated and the mutable path is
never read after capture. Duplicate content converges on the same root; unjournaled
roots remain harmless orphans.
