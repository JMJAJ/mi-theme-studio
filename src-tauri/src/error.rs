use serde::Serialize;

/// Error type returned to the frontend. It always serializes to
/// `{ code, message }` so the UI can branch on `code` and show `message`.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new("conflict", message)
    }
    pub fn no_project() -> Self {
        Self::new("no_project", "No theme package is open.")
    }
    pub fn io(context: impl AsRef<str>, error: std::io::Error) -> Self {
        Self::new("io", format!("{}: {error}", context.as_ref()))
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new("io", error.to_string())
    }
}

impl From<zip::result::ZipError> for AppError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::new("archive", format!("The archive could not be read: {error}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
