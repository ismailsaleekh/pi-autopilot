# Real Git adapter suite

Runs the centrally owned Git law vector unchanged against `GitAdapter`, plus
real repositories for exact-clone/A2 source preservation, hook injection,
renames, executable modes, symlinks, binary bytes, Unicode paths, and an atomic
two-publisher `update-ref` race.

Conflict observation is implemented by the adapter but full contract-level
conflict replay is blocked by the frozen `integrate-candidate` observation,
which has no `{kind:"conflict", details}` variant. See the L6 closure CAR.
