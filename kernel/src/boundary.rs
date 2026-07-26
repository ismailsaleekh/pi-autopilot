use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Producer {
    Model,
    VersionControl,
    Operator,
    Filesystem,
    Provider,
    BackgroundTask,
    Package,
    Host,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundaryMode {
    Record,
    Enforce,
}

#[derive(Debug, Eq, PartialEq)]
pub struct Rejection {
    boundary_id: &'static str,
    expected: String,
    actual: String,
    producer_visible: bool,
}

impl Rejection {
    pub fn boundary_id(&self) -> &'static str {
        self.boundary_id
    }

    pub fn expected(&self) -> &str {
        &self.expected
    }

    pub fn actual(&self) -> &str {
        &self.actual
    }

    pub fn producer_visible(&self) -> bool {
        self.producer_visible
    }

    fn from_registered(descriptor: &'static BoundaryDescriptor, actual: String) -> Self {
        Self {
            boundary_id: descriptor.id,
            expected: descriptor.admits.to_owned(),
            actual,
            producer_visible: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BoundaryDescriptor {
    id: &'static str,
    producer: Producer,
    admits: &'static str,
    mode: BoundaryMode,
}

impl BoundaryDescriptor {
    #[doc(hidden)]
    pub const fn __macro_new(
        id: &'static str,
        producer: Producer,
        admits: &'static str,
        mode: BoundaryMode,
    ) -> Self {
        Self {
            id,
            producer,
            admits,
            mode,
        }
    }

    pub fn id(&self) -> &'static str {
        self.id
    }

    pub fn producer(&self) -> Producer {
        self.producer
    }

    pub fn admits(&self) -> &'static str {
        self.admits
    }

    pub fn mode(&self) -> BoundaryMode {
        self.mode
    }
}

#[linkme::distributed_slice]
pub static BOUNDARIES: [BoundaryDescriptor] = [..];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundaryTransitionError {
    EnforceToRecordRefused { id: &'static str },
}

impl fmt::Display for BoundaryTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EnforceToRecordRefused { id } => {
                write!(formatter, "boundary {id} cannot move from enforce to record")
            }
        }
    }
}

impl std::error::Error for BoundaryTransitionError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundaryRegistrationError {
    NotRegistered { id: &'static str },
}

impl fmt::Display for BoundaryRegistrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRegistered { id } => write!(formatter, "boundary {id} is not registered"),
        }
    }
}

impl std::error::Error for BoundaryRegistrationError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BoundaryRuntime {
    descriptor: &'static BoundaryDescriptor,
    mode: BoundaryMode,
}

impl BoundaryRuntime {
    pub fn new(
        descriptor: &'static BoundaryDescriptor,
    ) -> Result<Self, BoundaryRegistrationError> {
        if is_registered(descriptor) {
            Ok(Self {
                descriptor,
                mode: descriptor.mode,
            })
        } else {
            Err(BoundaryRegistrationError::NotRegistered { id: descriptor.id })
        }
    }

    pub fn id(&self) -> &'static str {
        self.descriptor.id
    }

    pub fn mode(&self) -> BoundaryMode {
        self.mode
    }

    pub fn flip_to_enforce(&mut self) {
        self.mode = BoundaryMode::Enforce;
    }

    pub fn flip_to_record(&mut self) -> Result<(), BoundaryTransitionError> {
        match self.mode {
            BoundaryMode::Record => Ok(()),
            BoundaryMode::Enforce => Err(BoundaryTransitionError::EnforceToRecordRefused {
                id: self.descriptor.id,
            }),
        }
    }

    pub fn reject(&self, actual: impl Into<String>) -> Result<(), Rejection> {
        match self.mode {
            BoundaryMode::Record => Ok(()),
            BoundaryMode::Enforce => Err(Rejection::from_registered(self.descriptor, actual.into())),
        }
    }
}

pub fn boundary_by_id(id: &str) -> Option<&'static BoundaryDescriptor> {
    BOUNDARIES.iter().find(|descriptor| descriptor.id == id)
}

fn is_registered(descriptor: &'static BoundaryDescriptor) -> bool {
    BOUNDARIES.iter().any(|registered| core::ptr::eq(registered, descriptor))
}
