# Architecture Amendment 002 — Unified W2 Authority and Reality Cut

**Scope:** replace the stale W1 protocol assumptions with one coherent bounded
Amendment-002 authority/runtime/storage/six-port protocol; restore public T1/T2,
canonical evidence and command settlement, durable child fencing, real adapter
parity, and the W2 suite registrations without a compatibility protocol.

**Operator authority:** explicitly authorized by the W2 Amendment-002 integration
prompt, including authority to create this marker, regenerate the successor
fingerprints/protection manifest with approved tooling, and create the contiguous
`governance-baseline-002` tag only after the reviewed amendment is committed.

```architecture-amendment
{
  "format": 1,
  "id": "002",
  "operatorApproval": "W2 Amendment-002 integration prompt: operator-authorized coherent Amendment-002 protocol cut and governance successor",
  "rationale": "Adopt bounded authenticated authority state, closed semantic ingress, atomic settlement and exactly T1/T2, canonical Git/CAS and evidence bindings, durable descriptor-based child fencing, exactly six amended ports with fake/real law parity, one journal append edge, and register the non-vacuous W2 and storage certification suites.",
  "protectedFiles": [
    "authority/protocol/accepted-batch.ts",
    "policy-root/amendments/ARCHITECTURE-AMENDMENT-002.md",
    "policy-root/architecture-checker.ts",
    "policy-root/gate-self-tests.ts",
    "policy-root/generate-aggregates.ts",
    "policy-root/protected-files.json",
    "policy-root/protocol-fingerprints.json",
    "policy-root/required-suites.json"
  ],
  "fingerprintChanges": [
    {
      "capsule": "Atom",
      "oldDigest": null,
      "newDigest": "sha256:371792b3b4183754443303041eeb2908b7615662ed49e1207397cd2c96d14b71"
    },
    {
      "capsule": "ChildIntent",
      "oldDigest": "sha256:e18efbe55c8935ec48b99e3f1edfd129d4889f1714dd024e5f314deebc0c6ba5",
      "newDigest": "sha256:3799d72ed924c7230bc692d508fd51f6457d1fe378209ab3d743726e72465cae"
    },
    {
      "capsule": "ChildObservation",
      "oldDigest": "sha256:0d80c9f86269a4a499a5d503a87d71b44288355f1d1a13e15d7b69d3124cfd1b",
      "newDigest": "sha256:93101e10da64700574202abc8b0c8e20a38d0186ce556b94d39e7c59429d920c"
    },
    {
      "capsule": "ClockIntent",
      "oldDigest": "sha256:351beabb513d942e5d84dda36c4dea33c60e855015d607fdba403d33efd68199",
      "newDigest": "sha256:af613117a13aeff14a59fc41acf526a1ab0944cb642550023e092fd3a17de188"
    },
    {
      "capsule": "ClockObservation",
      "oldDigest": "sha256:7f34e1d6db545ed594b63be68f5608f0bb4e3e495578472de2d840bdab266d37",
      "newDigest": "sha256:f88489640d603b28dd8fc19028320ca6309fddbba3ccf33d0d104aaef666e305"
    },
    {
      "capsule": "Command",
      "oldDigest": "sha256:9e2a199d056ef3587305408faa921dc116b32bbf98d68c1db1fbb49b13aed4de",
      "newDigest": "sha256:ebcf802644869784d1e0d929bedb5fb1f80c5ffa48485ed51852f75633ec2d97"
    },
    {
      "capsule": "DomainFact",
      "oldDigest": "sha256:c9726de96a02298a6b303cd1f3021ae9afb7288b5ed9e072fda6e6f7279b24a8",
      "newDigest": "sha256:3e780910dcf07814c07261062248e8cd80ce15b84690d8c87c48ccc7279e136c"
    },
    {
      "capsule": "EvidenceFact",
      "oldDigest": "sha256:8167270a5281ee1b1fb7072e152aa2f1b79479bdc7387ac231045a5c3ddd1539",
      "newDigest": "sha256:566e235b576aab7f506f456632496474e1aad8fa6612524dc470d47f76df9495"
    },
    {
      "capsule": "Finding",
      "oldDigest": "sha256:2f060e69b7a939930eb9227e574abcbe595fbe4dc376597796b42067f54380c5",
      "newDigest": "sha256:d3d2a472d8f242f234b5b6e1d0b6b4bff6f78ff8f7293309bfab15a9ab2b183d"
    },
    {
      "capsule": "GitIntent",
      "oldDigest": "sha256:50c6122b62a308e89223a4843973c4b034969c074b8aeb7e683c4bf1943698ac",
      "newDigest": "sha256:29ae8fbbf2ea6520225f47d6f7acd05e1f9266b469eb4f66637b58be5d83b3f8"
    },
    {
      "capsule": "GitObservation",
      "oldDigest": "sha256:b3f9f17792f4a56fcbfdf318b2880fad1bbece9fa6ac620dc7003f2a546d2763",
      "newDigest": "sha256:5e68b7f649d5a3be2d0d0972177ace6baaedf84ff011964a2e1924a181cc9327"
    },
    {
      "capsule": "IngestDecision",
      "oldDigest": "sha256:6725d692a54ead1e6f093c8a8ac176923a2fee871637893d52c572f2fa985ca7",
      "newDigest": "sha256:0258ff46c295f01c23133c0af28e7d31b2a29fd9fd96c7b6179ae01813b16854"
    },
    {
      "capsule": "JournalRecord",
      "oldDigest": "sha256:fc0158ceeb596c8726abf893277e94d9499c791c7f222ab549fee9342bd85a0f",
      "newDigest": "sha256:30823ef7cba927f153823603dfcd0d1f8a8599ae4b29a0be7231422255a467a1"
    },
    {
      "capsule": "RouteContract",
      "oldDigest": null,
      "newDigest": "sha256:b0b97cba1e3fd6268d440c98710c77b9abe9fff27a9d911a287b804d22a2a2e6"
    },
    {
      "capsule": "SecretsIntent",
      "oldDigest": "sha256:ea71305447e6c6ee825c091635de8b280c57144351323a7c45c23fca69d3bcb6",
      "newDigest": "sha256:8a810aa207bc681aee366a7402d63aa1fd20400725a3b2b98a90e931c5052961"
    },
    {
      "capsule": "SecretsObservation",
      "oldDigest": "sha256:16febfdc551f32830178c3526c5d4c159e9591700e82867e3df948c425344155",
      "newDigest": "sha256:9bbff2ed2adceff2bb3d323a0d3648ab48818182993d95a2301e1c9ea1a34bc9"
    },
    {
      "capsule": "StateIndex",
      "oldDigest": null,
      "newDigest": "sha256:f139297dabb392c3f8669c65f2f0775930d0a61060f9111338a6fe6d25fb8fab"
    },
    {
      "capsule": "Stimulus",
      "oldDigest": "sha256:6c0a1621ad61ef9eeb452e8918dcf164c4dc4d304f2aeb3bad640fc18f048c1c",
      "newDigest": "sha256:aec6b5f5e6a694df94774a882477a3e7f6fd621b7a6c50308415447d9ed9da5f"
    },
    {
      "capsule": "StoreIntent",
      "oldDigest": "sha256:3d9993d0931a4bc981c9b86cb5ceeb4a151ef6b64ff999b09caf40c255115007",
      "newDigest": "sha256:295c617f54f03baaefae572b95b6cdb6e5aceb9179eb179efea3ae2c329676d0"
    },
    {
      "capsule": "StoreObservation",
      "oldDigest": "sha256:35991207c1532c0346860448d71833a6f9359c8a3bf4de4a060d3f1a13d806de",
      "newDigest": "sha256:93991383c11cf441e5a5b0ad0b23ffc0d2a8f1907a3ecaf3258ce99433a24efb"
    },
    {
      "capsule": "TerminalOutcome",
      "oldDigest": "sha256:3d982429a733f77d5a4b7bf352859f41017715a84b2615fd476666c79f00cc15",
      "newDigest": "sha256:525c4e5589a6613ba6ee4e7deb4cd29df8161a16d792c973f747e73ad9193352"
    },
    {
      "capsule": "ToolResult",
      "oldDigest": "sha256:c5b185f1132610a6a737b0b1632fc80b8c39ea6250f722dbf4f05c5ea528abc9",
      "newDigest": "sha256:863fa03304ba0e19c3e8b9bd64e98ed1fcbaa4094a8aaa2327e6a37299247433"
    },
    {
      "capsule": "WorkItem",
      "oldDigest": "sha256:3b8b98d88c537abc30e9d044f8b71008f363e4011cc0b6a0917781d52ba24167",
      "newDigest": "sha256:f5e9eed46503dd5134431ee7bce65c5c9d52d4ef646a2fb7c2f59ca84ffd94cf"
    },
    {
      "capsule": "WorkspaceIntent",
      "oldDigest": "sha256:ac1356f3dcc5a0e943c1bde67fbf2e6d87e046ef69a40e4c02b454975e2ce1b0",
      "newDigest": "sha256:f41132828cf2670b369b63b979120702b6815f1c2fb71c7b5dc6e9dc41cf5f30"
    },
    {
      "capsule": "WorkspaceObservation",
      "oldDigest": "sha256:e3ae18f07daf4cb6ecbff522209ea288b6c957df7b2149d7b0e7201c4e112a5b",
      "newDigest": "sha256:62ec15353ced87fcddb3bfe23654df39cd7a40926b222f809ee7413e9dcac1f4"
    }
  ]
}
```

## Rulings represented

- One authority, one journal, one `appendCommittedBatch` edge, exactly six ports,
  and exactly terminal outcomes T1/T2 remain non-negotiable.
- Runtime alone contains hostile host values; authority consumes only closed,
  bounded semantic stimuli and mints opaque prepared commits.
- Git, CAS, process, session, evidence, paging, and decimal identities remain
  physically distinct and connect only through explicit canonical attestations.
- Durable child descriptors and process birth markers, not live registries, own
  restart inspection and fencing; secret leases bind the same descriptor epoch.
- The same centrally owned six-port law vectors must pass against simulation and
  real adapters. D3.3 through D3.8 and D2.4 retain their later-wave ownership.
- D2.2, D2.5, D2.7, D3.1, and exact D3.2 are registered only with their observed
  non-vacuous commands; no skip, compatibility path, or narrowed vector is added.
