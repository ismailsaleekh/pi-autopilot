use crate::{failure::Failure, generated::EventRow, log::CacheImage};

pub trait Platform { fn clock(&self) -> &dyn Clock; fn entropy(&mut self) -> &mut dyn Entropy; fn store(&mut self) -> &mut dyn Store; }

pub trait Clock { fn read(&self) -> Timestamp; }

pub trait Entropy { fn next(&mut self) -> u64; }

pub trait Store {
    fn append_event(&mut self, row: &EventRow) -> Result<(), Failure>;
    fn write_cache(&mut self, image: &CacheImage) -> Result<(), Failure>;
    fn read_events(&self) -> Result<Vec<EventRow>, Failure>;
    fn read_cache(&self) -> Result<CacheRead, Failure>;
}

#[derive(Clone, Debug, PartialEq)]
pub enum CacheRead { Absent, Present(CacheImage) }

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Timestamp(pub u64);
