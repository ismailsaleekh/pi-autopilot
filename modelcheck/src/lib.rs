#[rustfmt::skip]
mod compact {
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use kdl::{KdlDocument, KdlEntry, KdlNode, KdlValue};

const PROPS: [&str; 8] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];

pub struct CheckReport { pub exit_code: u8, pub stdout: String, pub stderr: String }

pub fn run_path(path: &Path) -> CheckReport {
    match check_path(path) {
        Ok(v) => report(v),
        Err(e) => CheckReport { exit_code: 2, stdout: String::new(), stderr: format!("{e}\n") },
    }
}

fn check_path(path: &Path) -> Result<Vec<Violation>, String> {
    let src = std::fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let model = Model::parse(&src)?;
    let mut out = Vec::new();
    for machine in model.machines.values() { c1(machine, &mut out); c2(machine, &mut out); c3(machine, &mut out); c4(machine, &mut out); c6(machine, &mut out); }
    c5(&model, &mut out); c7(&model, &mut out); c8(&model, &mut out);
    Ok(out)
}

fn report(v: Vec<Violation>) -> CheckReport {
    let failed: BTreeSet<&str> = v.iter().map(|x| x.property).collect();
    let mut stdout = String::new();
    for p in PROPS { stdout.push_str(&format!("{p} {}\n", if failed.contains(p) { "FAIL" } else { "PASS" })); }
    let mut stderr = String::new();
    for x in &v { stderr.push_str(&format!("{} machine={} line={} {}\n", x.property, x.machine, x.line, x.message)); }
    CheckReport { exit_code: if v.is_empty() { 0 } else { 1 }, stdout, stderr }
}

#[derive(Clone)] struct State { terminal: bool, forward_gate: bool, implementer_active: bool, line: usize }
#[derive(Clone)] struct Transition { from: String, to: String, evidence: Option<String>, verdict_kind: Option<String>, verdict: Option<String>, line: usize }
struct Machine { name: String, initial: String, states: BTreeMap<String, State>, transitions: Vec<Transition> }
struct Total { machine: String, kind: String, from: String, line: usize }
struct Cap { name: String, gate: String, states: Vec<(String, usize)>, line: usize }
struct Model { machines: BTreeMap<String, Machine>, verdict_sets: BTreeMap<String, BTreeSet<String>>, totals: Vec<Total>, caps: Vec<Cap> }
#[derive(Clone)] struct Violation { property: &'static str, machine: String, line: usize, message: String }

impl Model {
    fn parse(src: &str) -> Result<Self, String> {
        let doc = src.parse::<KdlDocument>().map_err(|e| format!("failed to parse workflow.kdl: {e}"))?;
        let mut m = Self { machines: BTreeMap::new(), verdict_sets: BTreeMap::new(), totals: Vec::new(), caps: Vec::new() };
        let (mut schema, mut version) = (false, false);
        for n in doc.nodes() { match nn(n) {
            "schema" => { entries(n, 1, &[], src)?; if arg_s(n, 0, src)? != "autopilot.workflow.v1" { return Err(format!("bad schema at line {}", line(n, src))); } no_child(n, src)?; schema = true; }
            "version" => { entries(n, 1, &[], src)?; if arg_u(n, 0, src)? != 1 { return Err(format!("bad version at line {}", line(n, src))); } no_child(n, src)?; version = true; }
            "doc" => { entries(n, 1, &[], src)?; arg_s(n, 0, src)?; no_child(n, src)?; }
            "machine" => { let x = parse_machine(n, src)?; if m.machines.insert(x.name.clone(), x).is_some() { return Err(format!("duplicate machine at line {}", line(n, src))); } }
            "axis" => parse_axis(n, src)?,
            "attribute" => { entries(n, 1, &["contract", "doc"], src)?; arg_s(n, 0, src)?; prop_s(n, "contract", src)?; opt_s(n, "doc", src)?; no_child(n, src)?; }
            "verdict_set" => { let (k, v) = parse_verdict_set(n, src)?; if m.verdict_sets.insert(k, v).is_some() { return Err(format!("duplicate verdict_set at line {}", line(n, src))); } }
            "total_verdicts" => m.totals.push(parse_total(n, src)?),
            "capacity_class" => m.caps.push(parse_cap(n, src)?),
            other => return Err(format!("unknown node `{other}` at line {}", line(n, src))),
        }}
        if !schema || !version { return Err("workflow.kdl missing schema or version".to_owned()); }
        m.validate()?; Ok(m)
    }
    fn validate(&self) -> Result<(), String> {
        for machine in self.machines.values() {
            if !machine.states.contains_key(&machine.initial) { return Err(format!("machine `{}` initial `{}` is undeclared", machine.name, machine.initial)); }
            for e in &machine.transitions {
                if !machine.states.contains_key(&e.from) { return Err(format!("transition from undeclared state `{}` at line {}", e.from, e.line)); }
                if !machine.states.contains_key(&e.to) { return Err(format!("transition to undeclared state `{}` at line {}", e.to, e.line)); }
                match (&e.verdict_kind, &e.verdict) {
                    (Some(k), Some(v)) => { let set = self.verdict_sets.get(k).ok_or_else(|| format!("unknown verdict_kind `{k}` at line {}", e.line))?; if !set.contains(v) { return Err(format!("unknown verdict `{v}` at line {}", e.line)); } }
                    (None, None) => {}
                    _ => return Err(format!("partial verdict annotation at line {}", e.line)),
                }
            }
        }
        for t in &self.totals {
            let Some(machine) = self.machines.get(&t.machine) else { return Err(format!("total_verdicts unknown machine `{}` at line {}", t.machine, t.line)); };
            if !machine.states.contains_key(&t.from) { return Err(format!("total_verdicts unknown state `{}` at line {}", t.from, t.line)); }
            if !self.verdict_sets.contains_key(&t.kind) { return Err(format!("total_verdicts unknown kind `{}` at line {}", t.kind, t.line)); }
        }
        for c in &self.caps { if c.name == "implementer-active" && c.gate == "parallel_cap" {
            let Some(lane) = self.machines.get("lane") else { return Err(format!("capacity_class needs lane machine at line {}", c.line)); };
            for (s, l) in &c.states { if !lane.states.contains_key(s) { return Err(format!("capacity_class state `{s}` is not a lane state at line {l}")); } }
        }}
        Ok(())
    }
}

fn parse_machine(n: &KdlNode, src: &str) -> Result<Machine, String> {
    entries(n, 1, &[], src)?; let name = arg_s(n, 0, src)?.to_owned();
    let mut m = Machine { name, initial: String::new(), states: BTreeMap::new(), transitions: Vec::new() };
    for c in children(n, src)?.nodes() { match nn(c) {
        "doc" => { entries(c, 1, &[], src)?; arg_s(c, 0, src)?; no_child(c, src)?; }
        "initial" => { entries(c, 1, &[], src)?; if !m.initial.is_empty() { return Err(format!("duplicate initial at line {}", line(c, src))); } m.initial = arg_s(c, 0, src)?.to_owned(); no_child(c, src)?; }
        "state" => parse_state(c, src, &mut m)?,
        "transition" => { entries(c, 0, &["from", "to", "evidence", "verdict_kind", "verdict", "route", "doc"], src)?; opt_s(c, "doc", src)?; opt_s(c, "route", src)?; m.transitions.push(Transition { from: prop_s(c, "from", src)?.to_owned(), to: prop_s(c, "to", src)?.to_owned(), evidence: opt_s(c, "evidence", src)?.map(str::to_owned), verdict_kind: opt_s(c, "verdict_kind", src)?.map(str::to_owned), verdict: opt_s(c, "verdict", src)?.map(str::to_owned), line: line(c, src) }); no_child(c, src)?; }
        other => return Err(format!("unknown machine child `{other}` at line {}", line(c, src))),
    }}
    if m.initial.is_empty() { return Err(format!("machine `{}` missing initial", m.name)); }
    Ok(m)
}

fn parse_state(c: &KdlNode, src: &str, m: &mut Machine) -> Result<(), String> {
    entries(c, 1, &["terminal", "forward_gate", "integrated", "implementer_active", "validates", "round"], src)?;
    let name = arg_s(c, 0, src)?.to_owned();
    let forward_gate = opt_b(c, "forward_gate", src)?.is_some_and(|v| v);
    let implementer_active = opt_b(c, "implementer_active", src)?.is_some_and(|v| v);
    let s = State { terminal: prop_b(c, "terminal", src)?, forward_gate, implementer_active, line: line(c, src) };
    if let Some(v) = opt_s(c, "validates", src)? && v != "forward" && v != "closure" { return Err(format!("unknown validates `{v}` at line {}", line(c, src))); }
    if c.entry("integrated").is_some() { prop_b(c, "integrated", src)?; }
    if c.entry("round").is_some() { prop_u(c, "round", src)?; }
    no_child(c, src)?;
    if m.states.insert(name, s).is_some() { return Err(format!("duplicate state at line {}", line(c, src))); }
    Ok(())
}

fn parse_axis(n: &KdlNode, src: &str) -> Result<(), String> {
    entries(n, 1, &["contract"], src)?; arg_s(n, 0, src)?; prop_s(n, "contract", src)?;
    for c in children(n, src)?.nodes() { match nn(c) { "doc" => { entries(c, 1, &[], src)?; arg_s(c, 0, src)?; } "value" => { entries(c, 1, &[], src)?; arg_s(c, 0, src)?; } other => return Err(format!("unknown axis child `{other}` at line {}", line(c, src))), } no_child(c, src)?; }
    Ok(())
}

fn parse_verdict_set(n: &KdlNode, src: &str) -> Result<(String, BTreeSet<String>), String> {
    entries(n, 1, &["contract"], src)?; prop_s(n, "contract", src)?; let mut values = BTreeSet::new();
    for c in children(n, src)?.nodes() { match nn(c) { "value" => { entries(c, 1, &[], src)?; values.insert(arg_s(c, 0, src)?.to_owned()); } other => return Err(format!("unknown verdict_set child `{other}` at line {}", line(c, src))), } no_child(c, src)?; }
    Ok((arg_s(n, 0, src)?.to_owned(), values))
}

fn parse_total(n: &KdlNode, src: &str) -> Result<Total, String> {
    entries(n, 0, &["machine", "kind", "from", "doc"], src)?; opt_s(n, "doc", src)?; no_child(n, src)?;
    Ok(Total { machine: prop_s(n, "machine", src)?.to_owned(), kind: prop_s(n, "kind", src)?.to_owned(), from: prop_s(n, "from", src)?.to_owned(), line: line(n, src) })
}

fn parse_cap(n: &KdlNode, src: &str) -> Result<Cap, String> {
    entries(n, 1, &["gate", "doc"], src)?; opt_s(n, "doc", src)?; let mut states = Vec::new();
    for c in children(n, src)?.nodes() { match nn(c) { "state" => { entries(c, 1, &[], src)?; states.push((arg_s(c, 0, src)?.to_owned(), line(c, src))); } other => return Err(format!("unknown capacity_class child `{other}` at line {}", line(c, src))), } no_child(c, src)?; }
    Ok(Cap { name: arg_s(n, 0, src)?.to_owned(), gate: prop_s(n, "gate", src)?.to_owned(), states, line: line(n, src) })
}

fn add(v: &mut Vec<Violation>, p: &'static str, m: &str, line: usize, message: String) { v.push(Violation { property: p, machine: m.to_owned(), line, message }); }
fn c1(m: &Machine, v: &mut Vec<Violation>) { let seen = reachable(m, &m.initial); for (n, s) in &m.states { if !seen.contains(n) { add(v, "C1", &m.name, s.line, format!("state `{n}` is unreachable from `{}`", m.initial)); } } }
fn c2(m: &Machine, v: &mut Vec<Violation>) { for (n, s) in &m.states { if !s.terminal && !m.transitions.iter().any(|e| e.from == *n) { add(v, "C2", &m.name, s.line, format!("non-terminal state `{n}` has no outgoing transition")); } } }
fn c3(m: &Machine, v: &mut Vec<Violation>) { for c in components(m) { let cyclic = c.len() > 1 || m.transitions.iter().any(|e| e.from == c[0] && e.to == c[0]); if cyclic && !m.transitions.iter().any(|e| c.contains(&e.from) && !c.contains(&e.to)) { let l = m.states.get(&c[0]).map_or(1, |s| s.line); add(v, "C3", &m.name, l, format!("cycle has no exit edge: {}", c.join(","))); } } }
fn c4(m: &Machine, v: &mut Vec<Violation>) { let terms: Vec<&String> = m.states.iter().filter_map(|(n, s)| s.terminal.then_some(n)).collect(); for (n, s) in &m.states { if s.terminal { continue; } let seen = reachable(m, n); for t in &terms { if !seen.contains(*t) { add(v, "C4", &m.name, s.line, format!("terminal `{t}` is unreachable from non-terminal `{n}`")); } } } }
fn c5(model: &Model, v: &mut Vec<Violation>) { for t in &model.totals { let Some(m) = model.machines.get(&t.machine) else { continue; }; let Some(expected) = model.verdict_sets.get(&t.kind) else { continue; }; let actual: BTreeSet<String> = m.transitions.iter().filter(|e| e.from == t.from && e.verdict_kind.as_deref() == Some(t.kind.as_str())).filter_map(|e| e.verdict.clone()).collect(); if &actual != expected { add(v, "C5", &t.machine, t.line, format!("state `{}` verdict kind `{}` has {:?}, expected {:?}", t.from, t.kind, actual, expected)); } } }
fn c6(m: &Machine, v: &mut Vec<Violation>) { for e in &m.transitions { if e.evidence.as_deref().is_none_or(str::is_empty) { add(v, "C6", &m.name, e.line, format!("transition `{}->{}` lacks evidence", e.from, e.to)); } } }
fn c7(model: &Model, v: &mut Vec<Violation>) { let Some(lane) = model.machines.get("lane") else { return; }; let mut q = VecDeque::from([(lane.initial.clone(), false, lane.states.get(&lane.initial).map_or(1, |s| s.line))]); let mut seen = BTreeSet::new(); while let Some((s, gated, l)) = q.pop_front() { if !seen.insert((s.clone(), gated)) { continue; }
if s == "closed" && !gated { add(v, "C7", "lane", l, "closed is reachable before a forward_gate state".to_owned()); } for e in lane.transitions.iter().filter(|e| e.from == s) { let next = gated || lane.states.get(&e.to).is_some_and(|x| x.forward_gate); q.push_back((e.to.clone(), next, e.line)); } } }
fn c8(model: &Model, v: &mut Vec<Violation>) { let Some(lane) = model.machines.get("lane") else { return; }; let active: BTreeSet<String> = lane.states.iter().filter_map(|(n, s)| s.implementer_active.then_some(n.clone())).collect(); let mut found = false; for c in &model.caps { if c.gate != "parallel_cap" { continue; } found = true; for (s, l) in &c.states { if !active.contains(s) { add(v, "C8", "lane", *l, format!("parallel_cap includes non-implementer-active state `{s}`")); } } for s in &active { if !c.states.iter().any(|(n, _)| n == s) { add(v, "C8", "lane", c.line, format!("implementer-active state `{s}` missing from parallel_cap capacity_class")); } } } if !found { add(v, "C8", "lane", 1, "missing parallel_cap capacity_class".to_owned()); } }

fn reachable(m: &Machine, start: &str) -> BTreeSet<String> { let mut seen = BTreeSet::new(); let mut q = VecDeque::from([start.to_owned()]); while let Some(s) = q.pop_front() { if !seen.insert(s.clone()) { continue; } for e in m.transitions.iter().filter(|e| e.from == s) { q.push_back(e.to.clone()); } } seen }
fn components(m: &Machine) -> Vec<Vec<String>> { let names: Vec<String> = m.states.keys().cloned().collect(); let mut rev = BTreeMap::<String, Vec<String>>::new(); for e in &m.transitions { rev.entry(e.to.clone()).or_default().push(e.from.clone()); } let mut seen = BTreeSet::new(); let mut order = Vec::new(); for n in &names { dfs(n, m, &mut seen, &mut order); } seen.clear(); let mut out = Vec::new(); for n in order.into_iter().rev() { if seen.contains(&n) { continue; } let mut stack = vec![n]; let mut c = Vec::new(); while let Some(s) = stack.pop() { if !seen.insert(s.clone()) { continue; } c.push(s.clone()); if let Some(next) = rev.get(&s) { stack.extend(next.iter().cloned()); } } c.sort(); out.push(c); } out }
fn dfs(s: &str, m: &Machine, seen: &mut BTreeSet<String>, order: &mut Vec<String>) { if !seen.insert(s.to_owned()) { return; } for e in m.transitions.iter().filter(|e| e.from == s) { dfs(&e.to, m, seen, order); } order.push(s.to_owned()); }

fn entries(n: &KdlNode, positional: usize, allowed_props: &[&str], src: &str) -> Result<(), String> { let allowed: BTreeSet<&str> = allowed_props.iter().copied().collect(); let mut props = BTreeSet::new(); let mut pos = 0usize; for e in n.entries() { if e.ty().is_some() { return Err(format!("typed entry on `{}` at line {}", nn(n), line_e(e, src))); }
if let Some(name) = e.name() { let key = name.value(); if !allowed.contains(key) { return Err(format!("unknown property `{key}` on node `{}` at line {}", nn(n), line_e(e, src))); }
if !props.insert(key) { return Err(format!("duplicate property `{key}` on node `{}` at line {}", nn(n), line_e(e, src))); } } else { pos += 1; } } if pos != positional { return Err(format!("node `{}` at line {} requires {positional} argument(s), found {pos}", nn(n), line(n, src))); } Ok(()) }
fn children<'a>(n: &'a KdlNode, src: &str) -> Result<&'a KdlDocument, String> { n.children().ok_or_else(|| format!("node `{}` at line {} requires children", nn(n), line(n, src))) }
fn no_child(n: &KdlNode, src: &str) -> Result<(), String> { if n.children().is_some() { Err(format!("node `{}` at line {} must not have children", nn(n), line(n, src))) } else { Ok(()) } }
fn nn(n: &KdlNode) -> &str { n.name().value() }
fn arg_v<'a>(n: &'a KdlNode, i: usize, src: &str) -> Result<&'a KdlValue, String> { n.entries().iter().filter(|e| e.name().is_none()).nth(i).map(KdlEntry::value).ok_or_else(|| format!("missing argument {i} on node `{}` at line {}", nn(n), line(n, src))) }
fn arg_s<'a>(n: &'a KdlNode, i: usize, src: &str) -> Result<&'a str, String> { arg_v(n, i, src)?.as_string().ok_or_else(|| format!("argument {i} on node `{}` at line {} must be a string", nn(n), line(n, src))) }
fn arg_u(n: &KdlNode, i: usize, src: &str) -> Result<u64, String> { let v = arg_v(n, i, src)?.as_integer().ok_or_else(|| format!("argument {i} on node `{}` at line {} must be an integer", nn(n), line(n, src)))?; u64::try_from(v).map_err(|_| format!("argument {i} on node `{}` at line {} must be non-negative", nn(n), line(n, src))) }
fn prop_v<'a>(n: &'a KdlNode, k: &str, src: &str) -> Result<&'a KdlValue, String> { n.entry(k).map(KdlEntry::value).ok_or_else(|| format!("missing property `{k}` on node `{}` at line {}", nn(n), line(n, src))) }
fn prop_s<'a>(n: &'a KdlNode, k: &str, src: &str) -> Result<&'a str, String> { prop_v(n, k, src)?.as_string().ok_or_else(|| format!("property `{k}` on node `{}` at line {} must be a string", nn(n), line(n, src))) }
fn opt_s<'a>(n: &'a KdlNode, k: &str, src: &str) -> Result<Option<&'a str>, String> { match n.entry(k) { Some(e) => e.value().as_string().map(Some).ok_or_else(|| format!("property `{k}` on node `{}` at line {} must be a string", nn(n), line_e(e, src))), None => Ok(None) } }
fn prop_b(n: &KdlNode, k: &str, src: &str) -> Result<bool, String> { prop_v(n, k, src)?.as_bool().ok_or_else(|| format!("property `{k}` on node `{}` at line {} must be a boolean", nn(n), line(n, src))) }
fn opt_b(n: &KdlNode, k: &str, src: &str) -> Result<Option<bool>, String> { match n.entry(k) { Some(e) => e.value().as_bool().map(Some).ok_or_else(|| format!("property `{k}` on node `{}` at line {} must be a boolean", nn(n), line_e(e, src))), None => Ok(None) } }
fn prop_u(n: &KdlNode, k: &str, src: &str) -> Result<u64, String> { let v = prop_v(n, k, src)?.as_integer().ok_or_else(|| format!("property `{k}` on node `{}` at line {} must be an integer", nn(n), line(n, src)))?; u64::try_from(v).map_err(|_| format!("property `{k}` on node `{}` at line {} must be non-negative", nn(n), line(n, src))) }
fn line(n: &KdlNode, src: &str) -> usize { line_at(src, n.span().offset()) }
fn line_e(e: &KdlEntry, src: &str) -> usize { line_at(src, e.span().offset()) }
fn line_at(src: &str, off: usize) -> usize { src[..off.min(src.len())].bytes().filter(|b| *b == b'\n').count() + 1 }

}
pub use compact::{CheckReport, run_path};
