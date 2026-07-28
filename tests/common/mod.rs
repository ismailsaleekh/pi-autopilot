use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(crate) fn planning_replay_output(
    boundary_id: &str,
    spec: &serde_json::Value,
    spec_path: &Path,
    work_map_override: Option<&str>,
) -> String {
    let raw = if boundary_id == "planning.work-map.v1" {
        work_map_override
            .map(str::to_owned)
            .unwrap_or_else(|| planning_output(boundary_id))
    } else {
        planning_output(boundary_id)
    };
    match boundary_id {
        "planning.task-atoms.v1" => namespace_legacy_task_atoms(&raw, spec),
        "planning.work-map.v1" => namespace_legacy_work_map_links(&raw, spec, spec_path),
        _ => raw,
    }
}

fn planning_output(boundary_id: &str) -> String {
    match boundary_id {
        "planning.task-atoms.v1"
        | "planning.scout-dossier.v1"
        | "planning.work-map.v1"
        | "planning.plan-review.v1"
        | "planning.questions.v1" => transcript(boundary_id),
        other => panic!("unexpected planning boundary {other}"),
    }
}

fn namespace_legacy_task_atoms(raw: &str, spec: &serde_json::Value) -> String {
    let prefix = spec["atom_id_prefix"]
        .as_str()
        .expect("task atom replay spec must carry atom_id_prefix");
    let mut value: serde_json::Value = serde_json::from_str(raw).expect("task atoms replay json");
    let source_map = legacy_task_source_map(&value, spec);
    let atoms = value["atoms"]
        .as_array_mut()
        .expect("task atoms replay records must expose atoms[]");
    for atom in atoms {
        let id = atom["id"]
            .as_str()
            .expect("task atoms replay ids must be strings")
            .to_owned();
        assert!(!id.is_empty(), "task atoms replay id must be non-empty");
        let full_id = if id.starts_with(prefix) {
            id
        } else {
            format!("{prefix}{id}")
        };
        atom["id"] = serde_json::Value::String(full_id);

        let sources = atom["sources"]
            .as_array_mut()
            .expect("task atoms replay sources must be arrays");
        for source in sources {
            let raw_source = source
                .as_str()
                .expect("task atoms replay sources must be strings")
                .to_owned();
            let recorded_selector = task_source_document_selector(&raw_source);
            let bound_anchor = source_map
                .get(&recorded_selector)
                .unwrap_or_else(|| {
                    panic!("task atom replay source {raw_source} was not present in source map")
                })
                .clone();
            *source = serde_json::Value::String(bound_anchor);
        }
    }
    serde_json::to_string(&value).expect("task atoms replay json serialize")
}

fn legacy_task_source_map(
    value: &serde_json::Value,
    spec: &serde_json::Value,
) -> BTreeMap<String, String> {
    let atoms = value["atoms"]
        .as_array()
        .expect("task atoms replay records must expose atoms[]");
    let mut recorded_selectors = Vec::<String>::new();
    for atom in atoms {
        let sources = atom["sources"]
            .as_array()
            .expect("task atoms replay sources must be arrays");
        for source in sources {
            let selector = task_source_document_selector(
                source
                    .as_str()
                    .expect("task atoms replay sources must be strings"),
            );
            if !recorded_selectors.contains(&selector) {
                recorded_selectors.push(selector);
            }
        }
    }

    let authority_documents = spec["authority_documents"]
        .as_array()
        .expect("task atom replay spec must carry authority_documents[]");
    assert!(
        recorded_selectors.len() <= authority_documents.len(),
        "task atom replay cites {} task documents but spec binds only {} authority documents",
        recorded_selectors.len(),
        authority_documents.len()
    );
    recorded_selectors
        .into_iter()
        .enumerate()
        .map(|(index, selector)| {
            let document = &authority_documents[index];
            let digest = document["digest"]
                .as_str()
                .expect("task atom replay authority document digest");
            let path = document["path"]
                .as_str()
                .expect("task atom replay authority document path");
            assert!(
                !digest.is_empty(),
                "task atom replay authority digest is empty"
            );
            assert!(!path.is_empty(), "task atom replay authority path is empty");
            (selector, format!("task://{digest}/{path}#whole-file"))
        })
        .collect()
}

fn task_source_document_selector(source: &str) -> String {
    let without_scheme = source.strip_prefix("task://").unwrap_or(source);
    let document = without_scheme
        .split_once('#')
        .map(|(document, _)| document)
        .or_else(|| {
            without_scheme
                .split_once(" §")
                .map(|(document, _)| document)
        })
        .unwrap_or(without_scheme);
    assert!(
        !document.is_empty(),
        "task atom replay source document is empty"
    );
    document.to_owned()
}

fn namespace_legacy_work_map_links(
    raw: &str,
    spec: &serde_json::Value,
    spec_path: &Path,
) -> String {
    let local_to_full = atom_local_to_full_ids(spec, spec_path);
    let full_ids = local_to_full.values().cloned().collect::<BTreeSet<_>>();
    let mut value: serde_json::Value = serde_json::from_str(raw).expect("work-map replay json");
    let units = value["units"]
        .as_array_mut()
        .expect("work-map replay records must expose units[]");
    for unit in units {
        let links = unit["links"]
            .as_array_mut()
            .expect("work-map replay links must be arrays");
        for link in links {
            let raw_link = link
                .as_str()
                .expect("work-map replay links must be strings")
                .to_owned();
            if let Some(full_id) = local_to_full.get(&raw_link) {
                *link = serde_json::Value::String(full_id.clone());
            } else if !full_ids.contains(&raw_link) {
                panic!("work-map replay link {raw_link} is not present in the bound atom registry");
            }
        }
    }
    serde_json::to_string(&value).expect("work-map replay json serialize")
}

fn atom_local_to_full_ids(spec: &serde_json::Value, spec_path: &Path) -> BTreeMap<String, String> {
    let registry_path = spec["atom_registry_path"]
        .as_str()
        .expect("work-map replay spec must carry atom_registry_path");
    let registry: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(registry_path).expect("work-map replay atom registry"),
    )
    .expect("work-map replay atom registry json");
    let specs_dir = spec_path.parent().expect("planning spec directory");
    let mut prefix_by_assignment = BTreeMap::new();
    let mut local_to_full = BTreeMap::new();
    let mut local_fingerprints = BTreeMap::new();
    let atoms = registry["atoms"]
        .as_array()
        .expect("work-map replay registry must expose atoms[]");
    for atom in atoms {
        let full_id = atom["id"]
            .as_str()
            .expect("work-map replay registry atom id")
            .to_owned();
        let producer_assignment_id = atom["producer_assignment_id"]
            .as_str()
            .expect("work-map replay registry producer_assignment_id")
            .to_owned();
        if !prefix_by_assignment.contains_key(&producer_assignment_id) {
            let producer_spec_path = specs_dir.join(format!("{producer_assignment_id}.json"));
            let producer_spec: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(&producer_spec_path).expect("producer atom spec"),
            )
            .expect("producer atom spec json");
            let prefix = producer_spec["atom_id_prefix"]
                .as_str()
                .expect("producer atom spec must carry atom_id_prefix")
                .to_owned();
            prefix_by_assignment.insert(producer_assignment_id.clone(), prefix);
        }
        let prefix = prefix_by_assignment
            .get(&producer_assignment_id)
            .expect("inserted atom prefix");
        let local_id = full_id
            .strip_prefix(prefix.as_str())
            .unwrap_or_else(|| {
                panic!("registry atom id {full_id} does not match producer prefix {prefix}")
            })
            .to_owned();
        assert!(
            !local_id.is_empty(),
            "registry atom id must retain local suffix"
        );
        let fingerprint = serde_json::json!({
            "kind": atom["kind"].clone(),
            "text": atom["text"].clone(),
            "sources": atom["sources"].clone(),
        });
        if let Some(previous_fingerprint) = local_fingerprints.get(&local_id) {
            assert_eq!(
                previous_fingerprint, &fingerprint,
                "legacy replay atom id {local_id} is ambiguous between non-equivalent registry atoms"
            );
            continue;
        }
        local_fingerprints.insert(local_id.clone(), fingerprint);
        local_to_full.insert(local_id, full_id);
    }
    local_to_full
}

fn transcript(boundary_id: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/transcripts")
        .join(boundary_id)
        .join("transcripts.json");
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).expect("transcript file"))
            .expect("transcript json");
    value["records"][0]["raw_output"]
        .as_str()
        .expect("raw output")
        .to_owned()
}
