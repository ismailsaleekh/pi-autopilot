use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use heck::{ToSnakeCase, ToUpperCamelCase};
use kdl::KdlNode;
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::kdl_read::{SourceDoc, name};
use crate::table::{NodeSpec, TableDoc, TableSpec};
use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct Contracts {
    pub schema: String,
    pub version: u64,
    pub types: BTreeSet<String>,
    pub artifacts: Vec<Artifact>,
    pub enums: Vec<EnumDef>,
    pub frames: Vec<Frame>,
}
#[derive(Debug, Clone)]
pub struct Artifact {
    pub name: String,
    pub schema: String,
    pub model_produced: bool,
    pub doc: String,
    pub admits: Option<String>,
    pub submit_tools: Vec<TerminalTool>,
    pub items: Vec<Item>,
}
#[derive(Debug, Clone)]
pub struct TerminalTool {
    pub name: String,
    pub label: String,
    pub profile: String,
    pub result_contract: String,
    pub closed: bool,
}
#[derive(Debug, Clone)]
pub struct Frame {
    pub direction: String,
    pub kind: String,
    pub doc: String,
    pub items: Vec<Item>,
}
#[derive(Debug, Clone)]
pub struct EnumDef {
    pub name: String,
    pub values: Vec<String>,
    pub doc: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Field,
    List,
    Group,
    Record,
}
#[derive(Debug, Clone)]
pub struct Item {
    pub kind: ItemKind,
    pub name: String,
    pub type_id: String,
    pub required: bool,
    pub nullable: bool,
    pub doc: Option<String>,
    pub items: Vec<Item>,
}

macro_rules! host_specs {($($t:tt)*)=>{$($t)*};}
host_specs! { const SEAM_PROPS: &str = "kind|direction|posture|payload|adapter|effect|max_items|unique|doc"; pub const SEAM_SPEC: TableSpec<'_> = ("autopilot.seam.v1",1,"route",&[("route",0,SEAM_PROPS,"",0)]); const HOST_PROPS:&[NodeSpec<'_>]=&[("command",1,"activation|frame|public|description|adapter|payload","",1),("background_channel",1,"channel|schema","",1),("background_operation",1,"","",1),("background_status",1,"terminal","",1),("background_capability",1,"default","",1),("env_deny",1,"","",1),("effect",1,"operator_level_default|fail_closed|acknowledge|max_items","",1),("activation_record",1,"fields","",2)]; pub const HOST_RUNTIME_SPEC: TableSpec<'_>=("autopilot.host-runtime.v1",1,"command|background_channel|background_operation|background_status|background_capability|env_deny|effect|activation_record",HOST_PROPS); pub const PI_RPC_SPEC: TableSpec<'_>=("autopilot.pi-rpc.v1",1,"command|wire_enum|wire_variant|wire_record|event|launch_flag|env_deny|size_limit|state|order_event|transition|forbidden",&[("command",1,"serde|variant|constructor|payload|request_id|begins_cycle|queued_not_delivered|manual_compaction|bootstrap_only","",1),("wire_enum",1,"serde_tag","",1),("wire_variant",1,"enum|variant|serde","",1),("wire_record",1,"fields","",1),("event",1,"variant|record|order|terminal_bytes|discard_counter|bootstrap_only|terminal_limit","",1),("launch_flag",1,"order|kind|name|value|identity_token|source","",1),("env_deny",1,"","",1),("size_limit",1,"bytes","",1),("state",1,"terminal_ok","",1),("order_event",1,"","",1),("transition",1,"from|event|to","",1),("forbidden",1,"from|event|reason","",1)]); }
macro_rules! seam_validator {($($t:tt)*)=>{$($t)*};}

impl Contracts {
    pub fn read(path: &Path) -> Result<Self> {
        let doc = SourceDoc::read(path)?;
        let mut out = Self::empty();
        for node in doc.nodes() {
            match name(node) {
                "schema" => out.schema = doc.leaf(node)?,
                "version" => out.version = doc.u64_leaf(node)?,
                "doc" => drop(doc.leaf(node)?),
                "type" => {
                    out.types.insert(parse_type(&doc, node)?);
                }
                "artifact" => out.artifacts.push(parse_artifact(&doc, node)?),
                "enum" => out.enums.push(parse_enum(&doc, node)?),
                "frame" => out.frames.push(parse_frame(&doc, node)?),
                "artifact_category" => doc.skip(node, 1, &["path", "doc"])?,
                "resource_gate" => doc.skip(
                    node,
                    1,
                    &["default", "counts", "doc", "value", "threshold", "effect"],
                )?,
                "scheduler_order" => doc.skip(node, 1, &["key", "direction"])?,
                other => return line_err(&doc, node, format!("unknown top-level node `{other}`")),
            }
        }
        require(
            !out.schema.is_empty(),
            "missing required top-level schema node",
        )?;
        require(out.version != 0, "missing required top-level version node")?;
        out.validate()?;
        Ok(out)
    }

    fn empty() -> Self {
        Self {
            schema: String::new(),
            version: 0,
            types: BTreeSet::new(),
            artifacts: Vec::new(),
            enums: Vec::new(),
            frames: Vec::new(),
        }
    }

    seam_validator! { pub fn validate_seam(&self,seam:&TableDoc)->Result<()>{let mut seen=BTreeSet::new();for row in &seam.rows{let(k,d,s)=(row.string("kind")?,row.string("direction")?,row.string("posture")?);let(p,a,e)=(row.string("payload")?,row.string("adapter")?,row.string("effect")?);let err=|m:&str|Error::input(format!("{m} `{k}` at line {}",row.line));if !seen.insert((d,k)){return Err(err("duplicate seam route"));}let Some(frame)=self.frames.iter().find(|f|f.direction==d&&f.kind==k)else{return Err(err("seam route has no contract frame"));};if p!=frame_payload(frame){return Err(err("seam route direction/payload drift"));};if !matches!((s,d,a!="none",e!="none"),("supported","host-to-core",true,false)|("supported","core-to-host",false,true)|("unsupported",_,true,true)){return Err(err("seam route invalid posture/adapter/effect"));}let max=row.props.iter().find(|p|p.0=="max_items").and_then(|p|p.1.as_integer());let unique=row.opt_string("unique")?;if ((k=="spawn-wave")!=(max.is_some()||unique.is_some()))||(k=="spawn-wave"&&(max!=Some(64)||unique!=Some("action_id|assignment_id"))){return Err(err("seam route spawn-wave constraints"));}}for f in &self.frames{if !seen.contains(&(f.direction.as_str(),f.kind.as_str())){return Err(Error::input(format!("contract frame without seam route: {}:{}",f.direction,f.kind)));}}require(seen.len()==15,"seam routes must total exactly 15 contract frames")?;Ok(())} pub fn validate_host_runtime(&self,host:&TableDoc,seam:&TableDoc)->Result<()>{let rows=|t:&str|host.rows.iter().filter(move|r|r.table==t).collect::<Vec<_>>();let names=|t:&str|rows(t).iter().map(|r|r.key.as_str()).collect::<Vec<_>>();let exp_cmd="autopilot-plan autopilot autopilot-onboard autopilot-inject autopilot-status autopilot-config autopilot-handoff autopilot-close autopilot-abort autopilot-answer".split_whitespace().collect::<Vec<_>>();require(names("command")==exp_cmd,"host runtime command rows drift")?;require(rows("command").iter().filter(|r|r.string("activation").is_ok_and(|v|v=="activating")).count()==4,"host runtime activating command count drift")?;for r in rows("command"){let(f,a,p)=(r.string("frame")?,r.string("adapter")?,r.string("payload")?);require(matches!(r.string("activation")?,"activating"|"operating")&&r.bool("public")?,format!("bad command row at line {}",r.line))?;let frame=self.frames.iter().find(|x|x.direction=="host-to-core"&&x.kind==f).ok_or_else(||Error::input(format!("command frame has no host-to-core route at line {}",r.line)))?;require(p==frame_payload(frame),format!("command payload drift at line {}",r.line))?;if f=="operator-answer"{require(a=="id-json-object"&&p=="HostToCoreOperatorAnswerPayload","operator-answer adapter/payload drift")?;let shape=frame.items.iter().map(|i|(i.name.as_str(),i.type_id.as_str(),i.required,i.nullable)).collect::<Vec<_>>();require(shape==[("question_id","id",true,false),("answer","object",true,false)],"operator-answer contract shape drift")?;}else{require(a=="raw",format!("command adapter must remain raw at line {}",r.line))?;}}require(names("background_channel")==["request","response","terminal"],"background channel rows drift")?;require(names("background_operation")==["capabilities","run","status","logs","kill"],"background operation rows drift")?;require(names("background_status")==["running","completed","failed","killed"],"background status rows drift")?;for r in rows("env_deny"){require(r.key.bytes().all(|b|b.is_ascii_uppercase()||b==b'_'),format!("malformed env name at line {}",r.line))?;}for need in ["OPENAI_API_KEY","ANTHROPIC_API_KEY","OPENROUTER_API_KEY"]{require(names("env_deny").contains(&need),format!("missing env deny {need}"))?;}for r in rows("effect"){let k=r.key.as_str();require(seam.rows.iter().any(|s|s.string("direction").is_ok_and(|d|d=="core-to-host")&&s.string("kind").is_ok_and(|x|x==k)&&s.string("posture").is_ok_and(|p|p=="supported")),format!("effect/seam drift `{k}`"))?;if k=="spawn-wave"{let max=r.props.iter().find(|p|p.0=="max_items").and_then(|p|p.1.as_integer());require(max==Some(64),"spawn-wave max drift")?;}}require(names("effect")==["ui","spawn","spawn-wave","session","log","done"],"effect rows drift")?;let act=rows("activation_record");require(act.len()==1&&act[0].key=="autopilot.host_activation.v1"&&act[0].string("fields")?=="schema_version|session_id|process_identity|granted_by_command|activated_at_unix_ms","activation record row drift")?;Ok(())} }

    fn validate(&self) -> Result<()> {
        let mut known = builtin_scalar_types();
        known.extend(self.types.iter().cloned());
        known.extend(self.enums.iter().map(|e| e.name.clone()));
        known.extend(self.artifacts.iter().map(|a| a.name.clone()));
        for artifact in &self.artifacts {
            collect_records(&artifact.items, &mut known, None);
        }
        unique(self.artifacts.iter().map(|a| a.name.as_str()), "artifact")?;
        unique(
            self.artifacts
                .iter()
                .flat_map(|a| a.submit_tools.iter().map(|t| t.profile.as_str())),
            "terminal profile",
        )?;
        for artifact in &self.artifacts {
            check_types(
                &artifact.items,
                &known,
                &format!("artifact `{}`", artifact.name),
            )?;
        }
        for frame in &self.frames {
            check_types(&frame.items, &known, &format!("frame `{}`", frame.kind))?;
        }
        Ok(())
    }
}

fn parse_type(doc: &SourceDoc, node: &KdlNode) -> Result<String> {
    doc.entries(node, 1, &["doc"])?;
    doc.opt_string(node, "doc")?;
    doc.no_children(node)?;
    Ok(doc.arg_string(node, 0)?.to_owned())
}

fn parse_artifact(doc: &SourceDoc, node: &KdlNode) -> Result<Artifact> {
    doc.entries(node, 1, &["schema", "producer", "model_produced"])?;
    let artifact_name = doc.arg_string(node, 0)?.to_owned();
    let schema = doc.prop_string(node, "schema")?.to_owned();
    doc.prop_string(node, "producer")?;
    let mut out = Artifact {
        name: artifact_name.clone(),
        schema: schema.clone(),
        model_produced: doc.prop_bool(node, "model_produced")?,
        doc: String::new(),
        admits: None,
        submit_tools: Vec::new(),
        items: Vec::new(),
    };
    for child in doc.children(node)?.nodes() {
        match name(child) {
            "doc" => out.doc = doc.leaf(child)?,
            "admits" => {
                out.admits = Some(nonempty(
                    doc,
                    child,
                    &format!("artifact `{artifact_name}` admits"),
                )?)
            }
            "submit_tool" => {
                out.submit_tools
                    .push(parse_tool(doc, child, &artifact_name, &schema)?)
            }
            "field" | "list" | "group" | "record" => out.items.push(parse_item(
                doc,
                child,
                &format!("artifact `{artifact_name}`"),
            )?),
            "pattern" => doc.skip(child, 1, &["anchor_form", "value", "doc"])?,
            "constant" => doc.skip(child, 1, &["value", "doc"])?,
            other => {
                return line_err(
                    doc,
                    child,
                    format!("unknown child node `{other}` in artifact `{artifact_name}`"),
                );
            }
        }
    }
    require(
        !out.doc.is_empty(),
        format!("missing doc in artifact `{artifact_name}`"),
    )?;
    require(
        !out.model_produced || out.admits.is_some(),
        format!("model-produced artifact `{artifact_name}` is missing non-empty admits text"),
    )?;
    Ok(out)
}

fn parse_tool(
    doc: &SourceDoc,
    node: &KdlNode,
    artifact: &str,
    schema: &str,
) -> Result<TerminalTool> {
    doc.entries(node, 1, &["label", "profile", "result_contract", "closed"])?;
    let name = doc.arg_string(node, 0)?.to_owned();
    require(
        name.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
        format!("submit_tool `{name}` in artifact `{artifact}` must match [a-z0-9_]+"),
    )?;
    let tool = TerminalTool {
        profile: doc
            .opt_string(node, "profile")?
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{schema}:{name}")),
        result_contract: doc
            .opt_string(node, "result_contract")?
            .map(str::to_owned)
            .unwrap_or_else(|| schema.to_owned()),
        closed: doc.opt_bool(node, "closed")?.unwrap_or(false),
        label: doc.prop_string(node, "label")?.to_owned(),
        name,
    };
    doc.no_children(node)?;
    Ok(tool)
}

fn parse_frame(doc: &SourceDoc, node: &KdlNode) -> Result<Frame> {
    doc.entries(node, 0, &["direction", "kind"])?;
    let direction = doc.prop_string(node, "direction")?.to_owned();
    require(
        direction == "host-to-core" || direction == "core-to-host",
        format!(
            "unknown frame direction `{direction}` at line {}",
            doc.line(node)
        ),
    )?;
    let kind = doc.prop_string(node, "kind")?.to_owned();
    let mut out = Frame {
        direction,
        kind: kind.clone(),
        doc: String::new(),
        items: Vec::new(),
    };
    for child in doc.children(node)?.nodes() {
        match name(child) {
            "doc" => out.doc = doc.leaf(child)?,
            "field" | "list" | "group" | "record" => {
                out.items
                    .push(parse_item(doc, child, &format!("frame `{kind}`"))?)
            }
            other => {
                return line_err(
                    doc,
                    child,
                    format!("unknown child node `{other}` in frame `{kind}`"),
                );
            }
        }
    }
    require(
        !out.doc.is_empty(),
        format!("missing doc in frame `{kind}`"),
    )?;
    Ok(out)
}

fn parse_item(doc: &SourceDoc, node: &KdlNode, owner: &str) -> Result<Item> {
    let kind = match name(node) {
        "field" => ItemKind::Field,
        "list" => ItemKind::List,
        "group" => ItemKind::Group,
        "record" => ItemKind::Record,
        _ => unreachable!(),
    };
    let props = match kind {
        ItemKind::Field => &["type", "required", "nullable", "doc", "constant"][..],
        ItemKind::List => &["item", "required", "nullable", "doc"],
        ItemKind::Group => &["required"],
        ItemKind::Record => &[],
    };
    doc.entries(node, 1, props)?;
    let name = doc.arg_string(node, 0)?.to_owned();
    let type_id = match kind {
        ItemKind::Field => doc.prop_string(node, "type")?.to_owned(),
        ItemKind::List => doc.prop_string(node, "item")?.to_owned(),
        ItemKind::Group | ItemKind::Record => String::new(),
    };
    let required = matches!(kind, ItemKind::Field | ItemKind::List | ItemKind::Group)
        && doc.prop_bool(node, "required")?;
    if let Some(value) = doc.opt_string(node, "constant")? {
        validate_constant(doc, node, &name, &type_id, value)?;
    }
    let items = if matches!(kind, ItemKind::Group | ItemKind::Record) {
        parse_items(doc, node, owner)?
    } else {
        doc.no_children(node)?;
        Vec::new()
    };
    Ok(Item {
        kind,
        name,
        type_id,
        required,
        nullable: doc.opt_bool(node, "nullable")?.unwrap_or(false),
        doc: doc.opt_string(node, "doc")?.map(str::to_owned),
        items,
    })
}

fn parse_items(doc: &SourceDoc, node: &KdlNode, owner: &str) -> Result<Vec<Item>> {
    doc.children(node)?
        .nodes()
        .iter()
        .map(|child| match name(child) {
            "field" | "list" | "group" | "record" => parse_item(doc, child, owner),
            other => line_err(
                doc,
                child,
                format!("unknown child node `{other}` in {owner}"),
            ),
        })
        .collect()
}

fn parse_enum(doc: &SourceDoc, node: &KdlNode) -> Result<EnumDef> {
    doc.entries(node, 1, &[])?;
    let enum_name = doc.arg_string(node, 0)?.to_owned();
    let mut out = EnumDef {
        name: enum_name.clone(),
        values: Vec::new(),
        doc: None,
    };
    for child in doc.children(node)?.nodes() {
        match name(child) {
            "doc" => out.doc = Some(doc.leaf(child)?),
            "value" => out.values.push(doc.leaf(child)?),
            other => {
                return line_err(
                    doc,
                    child,
                    format!("unknown child node `{other}` in enum `{enum_name}`"),
                );
            }
        }
    }
    require(
        !out.values.is_empty(),
        format!("enum `{enum_name}` has no values"),
    )?;
    Ok(out)
}

fn nonempty(doc: &SourceDoc, node: &KdlNode, label: &str) -> Result<String> {
    let text = doc.leaf(node)?;
    require(
        !text.is_empty(),
        format!("empty {label} at line {}", doc.line(node)),
    )?;
    Ok(text)
}
fn validate_constant(
    doc: &SourceDoc,
    node: &KdlNode,
    field: &str,
    ty: &str,
    value: &str,
) -> Result<()> {
    let parsed = match ty {
        "u8" | "u32" | "u64" => value.parse::<u64>().map(|_| ()).map_err(|e| e.to_string()),
        "bool" => value.parse::<bool>().map(|_| ()).map_err(|e| e.to_string()),
        _ => Ok(()),
    };
    parsed.map_err(|error| {
        Error::input(format!(
            "constant `{value}` for field `{field}` at line {} is invalid: {error}",
            doc.line(node)
        ))
    })
}

fn frame_payload(frame: &Frame) -> String {
    let prefix = if frame.direction == "host-to-core" {
        "HostToCore"
    } else {
        "CoreToHost"
    };
    format!("{prefix}{}Payload", type_name(&frame.kind))
}

pub fn record_items_by_name(contracts: &Contracts) -> BTreeMap<String, Vec<Item>> {
    let mut records = BTreeMap::new();
    for artifact in &contracts.artifacts {
        collect_records(&artifact.items, &mut BTreeSet::new(), Some(&mut records));
    }
    records
}

/// Returns nested records plus top-level artifacts for JSON-schema expansion.
pub fn schema_items_by_name(contracts: &Contracts) -> BTreeMap<String, Vec<Item>> {
    let mut shapes = record_items_by_name(contracts);
    shapes.extend(
        contracts
            .artifacts
            .iter()
            .map(|artifact| (artifact.name.clone(), artifact.items.clone())),
    );
    shapes
}

fn collect_records(
    items: &[Item],
    known: &mut BTreeSet<String>,
    mut records: Option<&mut BTreeMap<String, Vec<Item>>>,
) {
    for item in items {
        if item.kind == ItemKind::Record {
            known.insert(item.name.clone());
            if let Some(map) = records.as_deref_mut() {
                map.insert(item.name.clone(), item.items.clone());
            }
        }
        collect_records(&item.items, known, records.as_deref_mut());
    }
}

pub fn json_schema_for_items(
    items: &[Item],
    shapes: &BTreeMap<String, Vec<Item>>,
    enums: &BTreeMap<&str, Vec<String>>,
    closed: bool,
) -> Result<JsonValue> {
    let mut properties = JsonMap::new();
    let mut required = Vec::new();
    for item in items {
        let mut value = match item.kind {
            ItemKind::Field => {
                json_schema_for_type(&item.type_id, shapes, enums, item.nullable, closed)?
            }
            ItemKind::List => list_schema(item, shapes, enums, closed)?,
            ItemKind::Group => json_schema_for_items(&item.items, shapes, enums, closed)?,
            ItemKind::Record => continue,
        };
        if let Some(doc) = &item.doc {
            add_schema_description(&mut value, doc)?;
        }
        properties.insert(item.name.clone(), value);
        if item.required {
            required.push(JsonValue::String(item.name.clone()));
        }
    }
    Ok(
        json!({ "type": "object", "additionalProperties": !closed, "properties": properties, "required": required }),
    )
}
fn add_schema_description(schema: &mut JsonValue, doc: &str) -> Result<()> {
    let Some(object) = schema.as_object_mut() else {
        return Err(Error::input(
            "json schema description target was not an object",
        ));
    };
    object.insert("description".to_owned(), JsonValue::String(doc.to_owned()));
    Ok(())
}

fn list_schema(
    item: &Item,
    shapes: &BTreeMap<String, Vec<Item>>,
    enums: &BTreeMap<&str, Vec<String>>,
    closed: bool,
) -> Result<JsonValue> {
    let value = json!({ "type": "array", "items": json_schema_for_type(&item.type_id, shapes, enums, false, closed)? });
    Ok(if item.nullable {
        json!({ "anyOf": [value, { "type": "null" }] })
    } else {
        value
    })
}
fn json_schema_for_type(
    type_id: &str,
    shapes: &BTreeMap<String, Vec<Item>>,
    enums: &BTreeMap<&str, Vec<String>>,
    nullable: bool,
    closed: bool,
) -> Result<JsonValue> {
    let mut schema = if let Some(values) = enums.get(type_id) {
        json!({ "type": "string", "enum": values })
    } else if let Some(items) = shapes.get(type_id) {
        json_schema_for_items(items, shapes, enums, closed)?
    } else {
        match type_id {
            "bool" => json!({ "type": "boolean" }),
            "u8" | "u32" | "u64" => json!({ "type": "integer", "minimum": 0 }),
            "object" | "json" | "control_observation" => {
                json!({ "type": "object", "additionalProperties": true })
            }
            _ => json!({ "type": "string" }),
        }
    };
    if nullable {
        schema = json!({ "anyOf": [schema, { "type": "null" }] });
    }
    Ok(schema)
}

pub fn scalar_newtypes(contracts: &Contracts) -> Vec<String> {
    let mut scalars = contracts
        .types
        .iter()
        .chain(builtin_scalar_types().iter())
        .filter(|n| should_emit_newtype(n))
        .cloned()
        .collect::<Vec<_>>();
    scalars.sort();
    scalars.dedup();
    scalars
}
fn check_types(items: &[Item], known: &BTreeSet<String>, owner: &str) -> Result<()> {
    for item in items {
        match item.kind {
            ItemKind::Field if !known.contains(&item.type_id) => {
                return unknown("type", item, owner);
            }
            ItemKind::List if !known.contains(&item.type_id) => {
                return unknown("list item type", item, owner);
            }
            _ => check_types(&item.items, known, owner)?,
        }
    }
    Ok(())
}
fn unknown(kind: &str, item: &Item, owner: &str) -> Result<()> {
    Err(Error::input(format!(
        "unknown {kind} `{}` for {:?} `{}` in {owner}",
        item.type_id, item.kind, item.name
    )))
}
fn unique<'a>(values: impl Iterator<Item = &'a str>, owner: &str) -> Result<()> {
    let mut seen = BTreeSet::new();
    for value in values {
        require(seen.insert(value), format!("duplicate {owner} `{value}`"))?;
    }
    Ok(())
}
fn builtin_scalar_types() -> BTreeSet<String> {
    "authority-class base32 bool contract-id control_observation delivery-boundary delivery-terminal-status duration event-kind mode-id object path permission redaction-state schema-id session-action string supersession-state test-id thinking-level tool-name trigger-kind u32 u64 u8 ui-kind uri validation-scope"
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

pub fn rust_scalar_type(type_id: &str) -> Option<&'static str> {
    match type_id {
        "string" => Some("String"),
        "bool" => Some("bool"),
        "u8" => Some("u8"),
        "u32" => Some("u32"),
        "u64" => Some("u64"),
        "control_observation" | "object" => Some("serde_json::Value"),
        _ => None,
    }
}
pub fn ts_scalar_type(type_id: &str) -> Option<&'static str> {
    match type_id {
        "string" => Some("string"),
        "bool" => Some("boolean"),
        "u8" | "u32" | "u64" => Some("number"),
        "control_observation" | "object" => Some("JsonObject"),
        _ => None,
    }
}
pub fn should_emit_newtype(type_id: &str) -> bool {
    rust_scalar_type(type_id).is_none()
}
pub fn rust_type_ref(type_id: &str) -> String {
    rust_scalar_type(type_id)
        .map(str::to_owned)
        .unwrap_or_else(|| type_name(type_id))
}
pub fn ts_type_ref(type_id: &str) -> String {
    ts_scalar_type(type_id)
        .map(str::to_owned)
        .unwrap_or_else(|| type_name(type_id))
}
pub fn rust_field_type(type_id: &str, required: bool, nullable: bool) -> String {
    wrap_required_nullable(&rust_type_ref(type_id), required, nullable)
}
pub fn ts_field_type(type_id: &str, nullable: bool) -> String {
    maybe_nullable(&ts_type_ref(type_id), nullable)
}
pub fn wrap_required_nullable(inner: &str, required: bool, nullable: bool) -> String {
    if !required {
        format!("Option<{inner}>")
    } else if nullable {
        format!("Nullable<{inner}>")
    } else {
        inner.to_owned()
    }
}
pub fn maybe_nullable(inner: &str, nullable: bool) -> String {
    if nullable {
        format!("{inner} | null")
    } else {
        inner.to_owned()
    }
}
pub fn type_name(input: &str) -> String {
    legal(input.to_upper_camel_case(), "GeneratedType", "N")
}
pub fn variant_name(input: &str) -> String {
    let name = legacy_name(input);
    if matches!(name.as_str(), "Self" | "Super" | "Crate") {
        format!("{name}Value")
    } else {
        name
    }
}
fn legacy_name(input: &str) -> String {
    let mut out = String::new();
    let mut up = true;
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(if up { c.to_ascii_uppercase() } else { c });
            up = false;
        } else {
            up = true;
        }
    }
    legal(out, "GeneratedType", "N")
}
pub fn field_name(input: &str) -> String {
    let out = legal(input.to_snake_case(), "field", "field_");
    if is_keyword(&out) {
        format!("{out}_")
    } else {
        out
    }
}
fn legal(out: String, empty: &str, digit_prefix: &str) -> String {
    match out.chars().next() {
        None => empty.to_owned(),
        Some(c) if c.is_ascii_digit() => format!("{digit_prefix}{out}"),
        Some(_) => out,
    }
}
fn is_keyword(input: &str) -> bool {
    "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"
        .split_whitespace()
        .any(|keyword| keyword == input)
}
pub fn quote_ts_key(input: &str) -> String {
    let ident = input.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && input
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if ident {
        input.to_owned()
    } else {
        format!("\"{}\"", escape_ts_string(input))
    }
}
pub fn escape_rust_string(input: &str) -> String {
    input.escape_default().to_string()
}
pub fn escape_ts_string(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}
pub fn json_string(value: &JsonValue, label: &str) -> Result<String> {
    serde_json::to_string(value).map_err(|error| Error::input(format!("{label} failed: {error}")))
}
fn line_err<T>(doc: &SourceDoc, node: &KdlNode, message: String) -> Result<T> {
    Err(Error::input(format!(
        "{message} at line {}",
        doc.line(node)
    )))
}
fn require(ok: bool, message: impl Into<String>) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::input(message.into()))
    }
}
