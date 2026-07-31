use std::path::Path;

use kdl::{KdlNode, KdlValue};

use crate::kdl_read::{SourceDoc, name};
use crate::{Error, Result};

pub type NodeSpec<'a> = (&'a str, usize, &'a str, &'a str, u8);
pub type TableSpec<'a> = (&'a str, u64, &'a str, &'a [NodeSpec<'a>]);
pub struct TableDoc {
    pub schema: String,
    pub version: u64,
    pub rows: Vec<TableRow>,
}
pub struct TableRow {
    pub table: String,
    pub key: String,
    pub props: Vec<(String, KdlValue)>,
    pub children: Vec<TableRow>,
    pub line: usize,
}

impl TableDoc {
    pub fn read(path: &Path, spec: &TableSpec<'_>) -> Result<Self> {
        Self::parse(&SourceDoc::read(path)?, spec)
    }
    pub fn parse(src: &SourceDoc, spec: &TableSpec<'_>) -> Result<Self> {
        let (mut schema, mut version, mut rows) = (None, None, Vec::new());
        for node in src.nodes() {
            match name(node) {
                "schema" => one(&mut schema, src, node, src.leaf(node)?, "schema")?,
                "version" => one(&mut version, src, node, src.u64_leaf(node)?, "version")?,
                _ => rows.push(row(src, node, spec, None)?),
            }
        }
        let schema =
            schema.ok_or_else(|| Error::input("workflow.kdl missing schema or version"))?;
        let version =
            version.ok_or_else(|| Error::input("workflow.kdl missing schema or version"))?;
        if schema != spec.0 {
            return Err(Error::input("bad schema"));
        } else if version != spec.1 {
            return Err(Error::input("bad version"));
        }
        dups(&rows, spec)?;
        Ok(Self {
            schema,
            version,
            rows,
        })
    }
}
impl TableRow {
    fn get(&self, key: &str) -> Option<&KdlValue> {
        self.props.iter().find(|p| p.0 == key).map(|p| &p.1)
    }
    pub fn string(&self, key: &str) -> Result<&str> {
        self.get(key)
            .and_then(KdlValue::as_string)
            .ok_or_else(|| bad(self, key, "string"))
    }
    pub fn opt_string(&self, key: &str) -> Result<Option<&str>> {
        opt(self, key, KdlValue::as_string, "string")
    }
    pub fn bool(&self, key: &str) -> Result<bool> {
        self.get(key)
            .and_then(KdlValue::as_bool)
            .ok_or_else(|| bad(self, key, "boolean"))
    }
    pub fn opt_bool(&self, key: &str) -> Result<Option<bool>> {
        opt(self, key, KdlValue::as_bool, "boolean")
    }
}

fn row(
    src: &SourceDoc,
    node: &KdlNode,
    table: &TableSpec<'_>,
    parent: Option<NodeSpec<'_>>,
) -> Result<TableRow> {
    let nm = name(node);
    let Some(spec) = table.3.iter().find(|s| s.0 == nm).copied() else {
        return Err(at(src, node, format!("unknown node `{nm}`")));
    };
    if parent.is_some_and(|p| !has(p.3, nm)) || parent.is_none() && !has(table.2, nm) {
        return Err(at(src, node, format!("unknown node `{nm}`")));
    }
    let props = spec
        .2
        .split('|')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    src.entries(node, spec.1, &props)?;
    let children = if spec.3.is_empty() {
        src.no_children(node)?;
        Vec::new()
    } else {
        src.children(node)?
            .nodes()
            .iter()
            .map(|n| row(src, n, table, Some(spec)))
            .collect::<Result<_>>()?
    };
    dups(&children, table)?;
    Ok(TableRow {
        table: nm.to_owned(),
        key: if spec.1 == 0 {
            String::new()
        } else {
            src.arg_string(node, 0)?.to_owned()
        },
        props: node
            .entries()
            .iter()
            .filter_map(|e| e.name().map(|n| (n.value().to_owned(), e.value().clone())))
            .collect(),
        children,
        line: src.line(node),
    })
}
fn dups(rows: &[TableRow], spec: &TableSpec<'_>) -> Result<()> {
    let mut seen = Vec::new();
    for r in rows {
        let flags = spec.3.iter().find(|s| s.0 == r.table).map_or(0, |s| s.4);
        let key = if flags & 2 != 0 {
            ""
        } else if flags & 1 != 0 {
            &r.key
        } else {
            continue;
        };
        if seen.contains(&(r.table.as_str(), key)) {
            return Err(Error::input(format!(
                "duplicate {} at line {}",
                r.table, r.line
            )));
        }
        seen.push((r.table.as_str(), key));
    }
    Ok(())
}
fn opt<'a, T>(
    row: &'a TableRow,
    key: &str,
    f: impl Fn(&'a KdlValue) -> Option<T>,
    ty: &str,
) -> Result<Option<T>> {
    row.get(key).map_or(Ok(None), |v| {
        f(v).map(Some).ok_or_else(|| bad(row, key, ty))
    })
}
fn one<T>(
    slot: &mut Option<T>,
    src: &SourceDoc,
    node: &KdlNode,
    value: T,
    label: &str,
) -> Result<()> {
    if slot.replace(value).is_some() {
        Err(at(src, node, format!("duplicate {label}")))
    } else {
        Ok(())
    }
}
fn has(list: &str, item: &str) -> bool {
    list.split('|').any(|s| s == item)
}
fn bad(row: &TableRow, key: &str, ty: &str) -> Error {
    Error::input(format!("`{key}` must be {ty} at line {}", row.line))
}
fn at(src: &SourceDoc, node: &KdlNode, message: String) -> Error {
    Error::input(format!("{message} at line {}", src.line(node)))
}
