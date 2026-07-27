use kernel::generated::{CONTRACT_VERSION, SeamEnvelope};

#[derive(Clone, Debug, Default)]
pub struct SimHost {
    next_id: u64,
    frames: Vec<SeamEnvelope>,
}

impl SimHost {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            frames: Vec::new(),
        }
    }

    pub fn push(
        &mut self,
        kind: impl Into<String>,
        payload: serde_json::Value,
    ) -> Result<u64, SimHostError> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(SimHostError::IdOverflow)?;
        self.frames.push(SeamEnvelope {
            v: CONTRACT_VERSION as u32,
            id,
            kind: kind.into(),
            payload,
        });
        Ok(id)
    }

    pub fn into_lines(self) -> Result<Vec<String>, SimHostError> {
        self.frames
            .iter()
            .map(|frame| serde_json::to_string(frame).map_err(SimHostError::Json))
            .collect()
    }
}

#[derive(Debug)]
pub enum SimHostError {
    IdOverflow,
    Json(serde_json::Error),
}

impl std::fmt::Display for SimHostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdOverflow => formatter.write_str("sim host id overflow"),
            Self::Json(error) => write!(formatter, "sim host json error: {error}"),
        }
    }
}

impl std::error::Error for SimHostError {}
