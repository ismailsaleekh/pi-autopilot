#[derive(Debug, Default)]
pub struct MemoryVcs {
    calls: Vec<String>,
}

impl MemoryVcs {
    pub fn new() -> Self {
        Self { calls: Vec::new() }
    }
    pub fn prepare(
        &mut self,
        root: &str,
        profile: &[&str],
    ) -> Result<(), kernel::failure::Failure> {
        self.calls
            .push(format!("prepare:{root}:{}", profile.join(",")));
        Ok(())
    }
    pub fn calls(&self) -> &[String] {
        &self.calls
    }
}
