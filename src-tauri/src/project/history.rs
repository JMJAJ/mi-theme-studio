//! Undo/redo history. Each [`Change`] stores the before/after blob pointers
//! for every path it touched, so undo and redo are exact and cheap.

use crate::package::blob::BlobRef;
use crate::project::Container;
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_HISTORY: usize = 300;

#[derive(Debug, Clone)]
pub struct FileDelta {
    pub path: String,
    pub before: Option<BlobRef>,
    pub after: Option<BlobRef>,
}

#[derive(Debug, Clone)]
pub struct ContainerDelta {
    pub name: String,
    pub before: Option<Arc<Container>>,
    pub after: Option<Arc<Container>>,
}

#[derive(Debug, Clone)]
pub struct Change {
    pub id: u64,
    pub label: String,
    pub at_ms: u64,
    pub files: Vec<FileDelta>,
    pub containers: Vec<ContainerDelta>,
}

impl Change {
    pub fn is_empty(&self) -> bool {
        self.files.iter().all(|d| same(&d.before, &d.after))
            && self
                .containers
                .iter()
                .all(|d| same_container(&d.before, &d.after))
    }
}

fn same(a: &Option<BlobRef>, b: &Option<BlobRef>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        _ => false,
    }
}

fn same_container(a: &Option<Arc<Container>>, b: &Option<Arc<Container>>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        _ => false,
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Saved {
    Never,
    At(Option<u64>),
}

#[derive(Debug)]
pub struct History {
    pub undo: Vec<Change>,
    pub redo: Vec<Change>,
    saved: Saved,
    next_id: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: u64,
    pub label: String,
    pub at_ms: u64,
    pub files: usize,
    /// `done` items are on the undo stack; others can be redone.
    pub done: bool,
}

impl History {
    pub fn new(saved: bool) -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
            saved: if saved { Saved::At(None) } else { Saved::Never },
            next_id: 1,
        }
    }

    pub fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn top(&self) -> Option<u64> {
        self.undo.last().map(|c| c.id)
    }

    pub fn is_dirty(&self) -> bool {
        match self.saved {
            Saved::Never => true,
            Saved::At(top) => top != self.top(),
        }
    }

    pub fn mark_saved_at(&mut self, top: Option<u64>) {
        self.saved = Saved::At(top);
    }

    pub fn push(&mut self, change: Change) {
        self.redo.clear();
        self.undo.push(change);
        if self.undo.len() > MAX_HISTORY {
            self.undo.remove(0);
        }
    }

    pub fn items(&self) -> Vec<HistoryItem> {
        let done = self.undo.iter().map(|c| (c, true));
        let undone = self.redo.iter().rev().map(|c| (c, false));
        done.chain(undone)
            .map(|(c, done)| HistoryItem {
                id: c.id,
                label: c.label.clone(),
                at_ms: c.at_ms,
                files: c.files.len(),
                done,
            })
            .collect()
    }
}
