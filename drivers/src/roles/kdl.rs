use kernel::boundary::{BoundaryDescriptor, BoundaryRuntime, boundary_by_id};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Block {
    pub(crate) id: String,
    pub(crate) fields: BTreeMap<String, Vec<String>>,
}

pub(crate) fn blocks(text: &str, kind: &str) -> Result<Vec<Block>, String> {
    let mut out = Vec::new();
    let mut lines = text.lines().enumerate();
    while let Some((line_no, raw)) = lines.next() {
        let line = clean(raw);
        if line.is_empty() {
            continue;
        }
        let Some(rest) = line
            .strip_prefix(kind)
            .and_then(|value| value.strip_prefix(' '))
        else {
            return Err(format!("line {}: expected {kind}", line_no + 1));
        };
        let id = quoted(rest)
            .into_iter()
            .next()
            .ok_or_else(|| format!("line {}: missing id", line_no + 1))?;
        let mut fields = BTreeMap::new();
        loop {
            let Some((child_no, child_raw)) = lines.next() else {
                return Err(format!("{kind} {id}: missing close"));
            };
            let child = clean(child_raw);
            if child == "}" {
                break;
            } else if child.is_empty() {
                continue;
            }
            let (key, rest) = child
                .split_once(' ')
                .ok_or_else(|| format!("line {}: missing value", child_no + 1))?;
            fields.insert(key.to_owned(), parse_values(rest));
        }
        out.push(Block { id, fields });
    }
    Ok(out)
}

pub(crate) fn one(fields: &BTreeMap<String, Vec<String>>, key: &str) -> Result<String, String> {
    fields
        .get(key)
        .and_then(|values| values.first())
        .cloned()
        .ok_or_else(|| format!("missing {key}"))
}

pub(crate) fn values(fields: &BTreeMap<String, Vec<String>>, key: &str) -> Vec<String> {
    match fields.get(key) {
        Some(values) => values.clone(),
        None => Vec::new(),
    }
}

pub(crate) fn table_values(text: &str, id: &str, key: &str) -> Result<Vec<String>, String> {
    for block in blocks(text, "table")? {
        if block.id == id {
            let values = values(&block.fields, key);
            return if values.is_empty() {
                Err(format!("{id}: missing {key}"))
            } else {
                Ok(values)
            };
        }
    }
    Err(format!("missing table {id}"))
}

pub(crate) fn attr(attrs: &str, name: &str) -> Option<String> {
    for attr in attrs.split_whitespace() {
        if let Some(value) = attr.strip_prefix(name) {
            return Some(value.trim_matches('"').to_owned());
        }
    }
    None
}

pub(crate) fn boundary_runtime(id: &'static str) -> BoundaryRuntime {
    let descriptor: &'static BoundaryDescriptor = match boundary_by_id(id) {
        Some(value) => value,
        None => panic!("missing boundary {id}"),
    };
    match BoundaryRuntime::new(descriptor) {
        Ok(value) => value,
        Err(error) => panic!("boundary runtime failed for {id}: {error}"),
    }
}

fn parse_values(text: &str) -> Vec<String> {
    let quoted = quoted(text);
    if quoted.is_empty() {
        vec![text.trim().to_owned()]
    } else {
        quoted
    }
}
fn clean(line: &str) -> &str {
    if let Some(value) = line.split("//").next() {
        value.trim()
    } else {
        ""
    }
}
fn quoted(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut open = false;
    let mut buf = String::new();
    for c in text.chars() {
        if c == '"' {
            if open {
                out.push(buf.clone());
                buf.clear();
            }
            open = !open;
        } else if open {
            buf.push(c);
        }
    }
    out
}
