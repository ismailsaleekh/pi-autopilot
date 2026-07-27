use std::fs;
use std::path::{Path, PathBuf};

use kernel::boundary::BoundaryMode;

use crate::roles::kdl::attr as kdl_attr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Eq, PartialEq)]
pub enum TranscriptError {
    BadMode(String),
    MissingMode(String),
    Regression(String),
    BadId(String),
    Io(String),
    Json(String),
    BadProvenance(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundaryModeTable {
    rows: Vec<(String, BoundaryMode)>,
}

impl BoundaryModeTable {
    pub fn parse(text: &str) -> Result<Self, TranscriptError> {
        let mut rows = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim();
            let Some(after) = trimmed.strip_prefix("boundary \"") else {
                continue;
            };
            let Some((id, attrs)) = after.split_once('"') else {
                return Err(TranscriptError::BadId(trimmed.to_owned()));
            };
            check_id(id)?;
            rows.push((id.to_owned(), parse_mode(id, attrs)?));
        }
        Ok(Self { rows })
    }

    pub fn mode(&self, id: &str) -> Result<BoundaryMode, TranscriptError> {
        for (row_id, mode) in &self.rows {
            if row_id == id {
                return Ok(*mode);
            }
        }
        Err(TranscriptError::MissingMode(id.to_owned()))
    }

    pub fn assert_one_way(&self, next: &Self) -> Result<(), TranscriptError> {
        for (id, mode) in &self.rows {
            if *mode == BoundaryMode::Enforce && next.mode(id)? == BoundaryMode::Record {
                return Err(TranscriptError::Regression(id.clone()));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TranscriptProvenance {
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TranscriptRecord {
    pub schema: String,
    pub boundary_id: String,
    pub raw_output: String,
    pub provenance: Option<TranscriptProvenance>,
}

impl TranscriptRecord {
    pub fn real(
        boundary_id: impl Into<String>,
        raw_output: impl Into<String>,
        provenance: TranscriptProvenance,
    ) -> Self {
        Self {
            schema: "autopilot.transcript.v1".to_owned(),
            boundary_id: boundary_id.into(),
            raw_output: raw_output.into(),
            provenance: Some(provenance),
        }
    }

    pub fn validate_real(&self) -> Result<(), TranscriptError> {
        let Some(provenance) = &self.provenance else {
            return Err(TranscriptError::BadProvenance(self.boundary_id.clone()));
        };
        if self.schema == "autopilot.transcript.v1"
            && !blank(&provenance.provider)
            && !blank(&provenance.model)
            && !blank(&provenance.thinking)
            && !blank(&provenance.session_id)
        {
            Ok(())
        } else {
            Err(TranscriptError::BadProvenance(self.boundary_id.clone()))
        }
    }

    pub fn replay(&self) -> Result<&str, TranscriptError> {
        self.validate_real()?;
        Ok(&self.raw_output)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct TranscriptSet {
    records: Vec<TranscriptRecord>,
}

pub struct TranscriptStore {
    root: PathBuf,
}

impl TranscriptStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    pub fn record(&self, record: &TranscriptRecord) -> Result<(), TranscriptError> {
        record.validate_real()?;
        check_id(&record.boundary_id)?;
        if let Some(provenance) = &record.provenance {
            check_id(&provenance.session_id)?;
        }
        let dir = self.boundary_dir(&record.boundary_id)?;
        fs::create_dir_all(&dir).map_err(map_io)?;
        let mut set = self.read_set(&dir)?;
        set.records.push(record.clone());
        fs::write(
            dir.join("transcripts.json"),
            serde_json::to_vec_pretty(&set).map_err(map_json)?,
        )
        .map_err(map_io)
    }

    pub fn load_boundary(
        &self,
        boundary_id: &str,
    ) -> Result<Vec<TranscriptRecord>, TranscriptError> {
        check_id(boundary_id)?;
        let set = self.read_set(&self.boundary_dir(boundary_id)?)?;
        for record in &set.records {
            if record.boundary_id != boundary_id {
                return Err(TranscriptError::BadProvenance(record.boundary_id.clone()));
            }
            record.validate_real()?;
        }
        Ok(set.records)
    }

    fn read_set(&self, dir: &Path) -> Result<TranscriptSet, TranscriptError> {
        match fs::read_to_string(dir.join("transcripts.json")) {
            Ok(text) => serde_json::from_str(&text).map_err(map_json),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TranscriptSet {
                records: Vec::new(),
            }),
            Err(error) => Err(map_io(error)),
        }
    }

    fn boundary_dir(&self, boundary_id: &str) -> Result<PathBuf, TranscriptError> {
        check_id(boundary_id)?;
        Ok(self.root.join(boundary_id))
    }
}

fn parse_mode(id: &str, attrs: &str) -> Result<BoundaryMode, TranscriptError> {
    match kdl_attr(attrs, "mode=").as_deref() {
        Some("record") => Ok(BoundaryMode::Record),
        Some("enforce") => Ok(BoundaryMode::Enforce),
        Some(other) => Err(TranscriptError::BadMode(format!("{id}:{other}"))),
        None => Err(TranscriptError::MissingMode(id.to_owned())),
    }
}

fn check_id(id: &str) -> Result<(), TranscriptError> {
    if !blank(id)
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_')
    {
        Ok(())
    } else {
        Err(TranscriptError::BadId(id.to_owned()))
    }
}

fn blank(value: &str) -> bool {
    value.trim().is_empty()
}

fn map_io(error: std::io::Error) -> TranscriptError {
    TranscriptError::Io(error.to_string())
}

fn map_json(error: serde_json::Error) -> TranscriptError {
    TranscriptError::Json(error.to_string())
}
