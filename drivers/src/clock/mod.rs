use std::time::{SystemTime, UNIX_EPOCH};

use kernel::platform::{Clock, Timestamp};

#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn read(&self) -> Timestamp {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => Timestamp(duration.as_millis() as u64),
            Err(_) => Timestamp(0),
        }
    }
}
