use std::collections::{BTreeSet, VecDeque};
use std::path::Path;

use codegen::Result;
use codegen::table::{NodeSpec, TableDoc, TableRow};

const P: [&str; 8] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];
const ROOT: &str = "doc|machine|axis|attribute|verdict_set|total_verdicts|capacity_class";
const STATE: &str = "terminal|forward_gate|integrated|implementer_active|validates|round";
const TRANSITION: &str = "from|to|evidence|verdict_kind|verdict|route|outcome|status|doc";
const N: &[NodeSpec<'_>] = &[
    ("doc", 1, "", "", 0),
    ("machine", 1, "", "doc|initial|state|transition", 1),
    ("initial", 1, "", "", 2),
    ("state", 1, STATE, "", 1),
    ("transition", 0, TRANSITION, "", 0),
    ("axis", 1, "contract", "doc|value", 1),
    ("attribute", 1, "contract|doc", "", 1),
    ("value", 1, "", "", 1),
    ("verdict_set", 1, "contract", "value", 1),
    ("total_verdicts", 0, "machine|kind|from|doc", "", 0),
    ("capacity_class", 1, "gate|doc", "state", 1),
];
const WORKFLOW_SPEC: (&str, u64, &str, &[NodeSpec<'_>]) = ("autopilot.workflow.v1", 1, ROOT, N);
type V = (&'static str, String, usize, &'static str);

pub struct CheckReport {
    pub exit_code: u8,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_path(path: &Path) -> CheckReport {
    match TableDoc::read(path, &WORKFLOW_SPEC).and_then(|d| check(&d)) {
        Ok(v) => report(v),
        Err(e) => CheckReport {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!("{e}\n"),
        },
    }
}
fn check(d: &TableDoc) -> Result<Vec<V>> {
    let mut out = Vec::new();
    for m in rows(d, "machine") {
        let terms = names(m, |s| s.bool("terminal").unwrap_or(false));
        let init = reach(m, initial(m))?;
        for s in kids(m, "state") {
            if !init.contains(&s.key) {
                push(&mut out, "C1", m, s.line, "unreachable");
            }
            if !s.bool("terminal")?
                && !kids(m, "transition").any(|e| prop(e, "from") == Some(s.key.as_str()))
            {
                push(&mut out, "C2", m, s.line, "no outgoing transition");
            }
            if !s.bool("terminal")? && terms.is_disjoint(&reach(m, &s.key)?) {
                push(&mut out, "C4", m, s.line, "no terminal reachable");
            }
        }
        cycles(m, &mut out);
        for e in kids(m, "transition").filter(|e| prop(e, "evidence").is_none_or(str::is_empty)) {
            push(&mut out, "C6", m, e.line, "missing evidence");
        }
    }
    totals(d, &mut out);
    gate(d, &mut out);
    cap(d, &mut out);
    Ok(out)
}
fn report(v: Vec<V>) -> CheckReport {
    let failed = v.iter().map(|v| v.0).collect::<BTreeSet<_>>();
    CheckReport {
        exit_code: u8::from(!v.is_empty()),
        stdout: P
            .map(|p| format!("{p} {}\n", if failed.contains(p) { "FAIL" } else { "PASS" }))
            .concat(),
        stderr: v
            .iter()
            .map(|(p, m, l, t)| format!("{p} machine={m} line={l} {t}\n"))
            .collect(),
    }
}
fn cycles(m: &TableRow, out: &mut Vec<V>) {
    for n in names(m, |_| true) {
        let f = reach(m, &n).unwrap_or_default();
        let c = f
            .iter()
            .filter(|s| reach(m, s).is_ok_and(|r| r.contains(&n)))
            .cloned()
            .collect::<BTreeSet<_>>();
        let exit = kids(m, "transition").any(|e| {
            c.iter().any(|s| prop(e, "from") == Some(s.as_str()))
                && !c.iter().any(|s| prop(e, "to") == Some(s.as_str()))
        });
        let self_loop = kids(m, "transition")
            .any(|e| prop(e, "from") == Some(n.as_str()) && prop(e, "to") == Some(n.as_str()));
        if (c.len() > 1 || self_loop) && !exit {
            push(out, "C3", m, 1, "cycle has no exit");
        }
    }
}
fn totals(d: &TableDoc, out: &mut Vec<V>) {
    for t in rows(d, "total_verdicts") {
        let (machine, kind, from) = (
            prop(t, "machine").unwrap_or(""),
            prop(t, "kind").unwrap_or(""),
            prop(t, "from").unwrap_or(""),
        );
        let Some(m) = row(d, "machine", machine) else {
            continue;
        };
        let got = kids(m, "transition")
            .filter(|e| prop(e, "from") == Some(from) && prop(e, "verdict_kind") == Some(kind))
            .filter_map(|e| prop(e, "verdict").map(str::to_owned))
            .collect::<BTreeSet<_>>();
        let expect = row(d, "verdict_set", kind).map_or_else(BTreeSet::new, |r| {
            kids(r, "value").map(|v| v.key.clone()).collect()
        });
        if got != expect {
            out.push(("C5", machine.to_owned(), t.line, "verdict set incomplete"));
        }
    }
}
fn gate(d: &TableDoc, out: &mut Vec<V>) {
    let Some(l) = row(d, "machine", "lane") else {
        return;
    };
    let mut q = VecDeque::from([(initial(l).to_owned(), false, 1)]);
    let mut seen = BTreeSet::new();
    while let Some((s, gated, line)) = q.pop_front() {
        if !seen.insert((s.clone(), gated)) {
            continue;
        }
        if s == "closed" && !gated {
            push(out, "C7", l, line, "closed before gate");
        }
        for e in kids(l, "transition").filter(|e| prop(e, "from") == Some(s.as_str())) {
            let Some(to) = prop(e, "to") else { continue };
            q.push_back((
                to.to_owned(),
                gated
                    || kids(l, "state").find(|s| s.key == to).is_some_and(|s| {
                        s.opt_bool("forward_gate").unwrap_or(None).unwrap_or(false)
                    }),
                e.line,
            ));
        }
    }
}
fn cap(d: &TableDoc, out: &mut Vec<V>) {
    let Some(l) = row(d, "machine", "lane") else {
        return;
    };
    let active = names(l, |s| {
        s.opt_bool("implementer_active")
            .unwrap_or(None)
            .unwrap_or(false)
    });
    let mut found = false;
    for c in rows(d, "capacity_class").filter(|c| prop(c, "gate") == Some("parallel_cap")) {
        found = true;
        for s in kids(c, "state") {
            if !active.contains(&s.key) {
                out.push(("C8", "lane".to_owned(), s.line, "bad cap state"));
            }
        }
        for s in &active {
            if !kids(c, "state").any(|r| &r.key == s) {
                out.push(("C8", "lane".to_owned(), c.line, "missing cap state"));
            }
        }
    }
    if !found {
        out.push(("C8", "lane".to_owned(), 1, "missing cap"));
    }
}
fn reach(m: &TableRow, start: &str) -> Result<BTreeSet<String>> {
    let mut seen = BTreeSet::new();
    let mut q = VecDeque::from([start.to_owned()]);
    while let Some(s) = q.pop_front() {
        if seen.insert(s.clone()) {
            for e in kids(m, "transition").filter(|e| prop(e, "from") == Some(s.as_str())) {
                q.push_back(e.string("to")?.to_owned());
            }
        }
    }
    Ok(seen)
}
fn names(m: &TableRow, keep: impl Fn(&TableRow) -> bool) -> BTreeSet<String> {
    kids(m, "state")
        .filter(|s| keep(s))
        .map(|s| s.key.clone())
        .collect()
}
fn initial(m: &TableRow) -> &str {
    kids(m, "initial").next().map_or("", |r| r.key.as_str())
}
fn row<'a>(d: &'a TableDoc, t: &'a str, key: &str) -> Option<&'a TableRow> {
    rows(d, t).find(|r| r.key == key)
}
fn rows<'a>(d: &'a TableDoc, t: &'a str) -> impl Iterator<Item = &'a TableRow> {
    d.rows.iter().filter(move |r| r.table == t)
}
fn kids<'a>(r: &'a TableRow, t: &'a str) -> impl Iterator<Item = &'a TableRow> {
    r.children.iter().filter(move |r| r.table == t)
}
fn prop<'a>(r: &'a TableRow, k: &str) -> Option<&'a str> {
    r.opt_string(k).unwrap_or(None)
}
fn push(out: &mut Vec<V>, p: &'static str, m: &TableRow, l: usize, t: &'static str) {
    out.push((p, m.key.clone(), l, t));
}
