use std::collections::BTreeSet;
use std::path::Path;

use kdl::{KdlDocument, KdlEntry, KdlNode, KdlValue};

use crate::{Error, Result};

pub struct SourceDoc {
    source: String,
    doc: KdlDocument,
}
impl SourceDoc {
    pub fn read(path: &Path) -> Result<Self> {
        let label = path.display();
        let source = std::fs::read_to_string(path)
            .map_err(|e| Error::input(format!("failed to read {label}: {e}")))?;
        let doc = source
            .parse::<KdlDocument>()
            .map_err(|e| Error::input(format!("failed to parse {label}: {e}")))?;
        Ok(Self { source, doc })
    }
    pub fn nodes(&self) -> &[KdlNode] {
        self.doc.nodes()
    }
    pub fn line(&self, node: &KdlNode) -> usize {
        line_for_offset(&self.source, node.span().offset())
    }
    pub fn entries(&self, node: &KdlNode, positional: usize, props: &[&str]) -> Result<()> {
        let allowed = props.iter().copied().collect::<BTreeSet<_>>();
        let mut seen = BTreeSet::new();
        let mut args = 0;
        for entry in node.entries() {
            if entry.ty().is_some() {
                return self.entry_err(entry, format!("typed entry on `{}`", name(node)));
            }
            match entry.name().map(|n| n.value()) {
                Some(key) if !allowed.contains(key) => {
                    return self.entry_err(
                        entry,
                        format!("unknown property `{key}` on node `{}`", name(node)),
                    );
                }
                Some(key) if !seen.insert(key) => {
                    return self.entry_err(
                        entry,
                        format!("duplicate property `{key}` on node `{}`", name(node)),
                    );
                }
                Some(_) => {}
                None => {
                    args += 1;
                    if args > positional {
                        return self.entry_err(
                            entry,
                            format!("unexpected argument {args} on `{}`", name(node)),
                        );
                    }
                }
            }
        }
        self.need(
            node,
            args == positional,
            format!(
                "node `{}` requires {positional} argument(s), found {args}",
                name(node)
            ),
        )
    }
    pub fn children<'a>(&self, node: &'a KdlNode) -> Result<&'a KdlDocument> {
        node.children()
            .ok_or_else(|| self.err(node, format!("node `{}` requires children", name(node))))
    }
    pub fn no_children(&self, node: &KdlNode) -> Result<()> {
        self.need(
            node,
            node.children().is_none(),
            format!("node `{}` must not have children", name(node)),
        )
    }
    pub fn arg_string<'a>(&self, node: &'a KdlNode, index: usize) -> Result<&'a str> {
        self.arg(node, index)?.as_string().ok_or_else(|| {
            self.err(
                node,
                format!("argument {index} on `{}` must be string", name(node)),
            )
        })
    }
    pub fn arg_u64(&self, node: &KdlNode, index: usize) -> Result<u64> {
        self.as_u64(node, self.arg(node, index)?, &format!("argument {index}"))
    }
    pub fn prop_string<'a>(&self, node: &'a KdlNode, key: &str) -> Result<&'a str> {
        self.prop(node, key)?.as_string().ok_or_else(|| {
            self.err(
                node,
                format!("property `{key}` on `{}` must be string", name(node)),
            )
        })
    }
    pub fn opt_string<'a>(&self, node: &'a KdlNode, key: &str) -> Result<Option<&'a str>> {
        self.opt(node, key, KdlValue::as_string, "string")
    }
    pub fn prop_bool(&self, node: &KdlNode, key: &str) -> Result<bool> {
        self.prop(node, key)?.as_bool().ok_or_else(|| {
            self.err(
                node,
                format!("property `{key}` on `{}` must be boolean", name(node)),
            )
        })
    }
    pub fn opt_bool(&self, node: &KdlNode, key: &str) -> Result<Option<bool>> {
        self.opt(node, key, KdlValue::as_bool, "boolean")
    }
    pub fn prop_u64(&self, node: &KdlNode, key: &str) -> Result<u64> {
        self.as_u64(node, self.prop(node, key)?, &format!("property `{key}`"))
    }
    pub fn leaf(&self, node: &KdlNode) -> Result<String> {
        self.entries(node, 1, &[])?;
        let text = self.arg_string(node, 0)?.to_owned();
        self.no_children(node)?;
        Ok(text)
    }
    pub fn u64_leaf(&self, node: &KdlNode) -> Result<u64> {
        self.entries(node, 1, &[])?;
        let value = self.arg_u64(node, 0)?;
        self.no_children(node)?;
        Ok(value)
    }
    pub fn skip(&self, node: &KdlNode, positional: usize, props: &[&str]) -> Result<()> {
        self.entries(node, positional, props)?;
        self.no_children(node)
    }
    fn arg<'a>(&self, node: &'a KdlNode, index: usize) -> Result<&'a KdlValue> {
        node.entries()
            .iter()
            .filter(|e| e.name().is_none())
            .nth(index)
            .map(KdlEntry::value)
            .ok_or_else(|| {
                self.err(
                    node,
                    format!("missing argument {index} on `{}`", name(node)),
                )
            })
    }
    fn prop<'a>(&self, node: &'a KdlNode, key: &str) -> Result<&'a KdlValue> {
        node.entry(key).map(KdlEntry::value).ok_or_else(|| {
            self.err(
                node,
                format!("missing required property `{key}` on `{}`", name(node)),
            )
        })
    }
    fn opt<'a, T>(
        &self,
        node: &'a KdlNode,
        key: &str,
        f: impl Fn(&'a KdlValue) -> Option<T>,
        ty: &str,
    ) -> Result<Option<T>> {
        match node.entry(key) {
            Some(entry) => f(entry.value()).map(Some).ok_or_else(|| {
                Error::input(format!(
                    "property `{key}` on `{}` must be {ty} at line {}",
                    name(node),
                    line_for_offset(&self.source, entry.span().offset())
                ))
            }),
            None => Ok(None),
        }
    }
    fn as_u64(&self, node: &KdlNode, value: &KdlValue, label: &str) -> Result<u64> {
        value
            .as_integer()
            .and_then(|n| u64::try_from(n).ok())
            .ok_or_else(|| {
                self.err(
                    node,
                    format!("{label} on `{}` must be non-negative", name(node)),
                )
            })
    }
    fn need(&self, node: &KdlNode, ok: bool, message: String) -> Result<()> {
        if ok {
            Ok(())
        } else {
            Err(self.err(node, message))
        }
    }
    fn entry_err<T>(&self, entry: &KdlEntry, message: String) -> Result<T> {
        Err(Error::input(format!(
            "{message} at line {}",
            line_for_offset(&self.source, entry.span().offset())
        )))
    }
    fn err(&self, node: &KdlNode, message: String) -> Error {
        Error::input(format!("{message} at line {}", self.line(node)))
    }
}

pub fn name(node: &KdlNode) -> &str {
    node.name().value()
}
pub fn line_for_offset(source: &str, offset: usize) -> usize {
    source[..offset.min(source.len())]
        .bytes()
        .filter(|b| *b == b'\n')
        .count()
        + 1
}
