use super::*;
use crate::package::archive::tests::build_zip;
use crate::package::archive::{read_package, zip_to_vec, WriteEntry};
use crate::package::blob::Compression::{Deflated, Stored};

fn sample_package() -> Vec<u8> {
    let icons = build_zip(&[
        (
            "res/drawable-xxhdpi/com.android.camera.png",
            b"camera",
            Deflated,
        ),
        (
            "res/drawable-xxhdpi/com.android.contacts.png",
            b"contacts",
            Deflated,
        ),
    ]);
    build_zip(&[
        (
            "description.xml",
            b"<MIUI-Theme><title>Sample</title><author>A</author></MIUI-Theme>",
            Deflated,
        ),
        ("icons", &icons, Stored),
        ("wallpaper/default_wallpaper.jpg", b"jpg", Stored),
        ("unknown/vendor.bin", &[0, 1, 2, 3], Deflated),
    ])
}

fn open() -> Project {
    Project::from_bytes(&sample_package(), "Sample.mtz", None, Limits::default()).unwrap()
}

fn export(project: &Project) -> Vec<u8> {
    let entries = project.export_entries().unwrap();
    let write: Vec<WriteEntry> = entries
        .iter()
        .map(|e| WriteEntry {
            path: &e.path,
            data: e.bytes(),
            compression: e.compression,
        })
        .collect();
    zip_to_vec(&write).unwrap()
}

#[test]
fn opens_nested_components() {
    let project = open();
    assert!(project.is_container("icons"));
    assert!(project
        .files
        .contains_key("icons!/res/drawable-xxhdpi/com.android.camera.png"));
    assert_eq!(project.title(), "Sample");
    assert!(!project.is_dirty());
}

#[test]
fn round_trip_preserves_unknown_files_and_unchanged_components() {
    let project = open();
    let original = sample_package();
    let exported = export(&project);
    let before = read_package(&original, "a", Limits::default()).unwrap();
    let after = read_package(&exported, "b", Limits::default()).unwrap();
    assert_eq!(before.order, after.order, "top-level order is kept");
    // The untouched icons archive is byte-identical.
    let icons_before = &before
        .nested
        .iter()
        .find(|n| n.0 == "icons")
        .unwrap()
        .1
        .data;
    let icons_after = &after.nested.iter().find(|n| n.0 == "icons").unwrap().1.data;
    assert_eq!(icons_before, icons_after);
    let vendor = after
        .outer
        .iter()
        .find(|e| e.path == "unknown/vendor.bin")
        .unwrap();
    assert_eq!(vendor.blob.data, vec![0, 1, 2, 3]);
    let wallpaper = after
        .outer
        .iter()
        .find(|e| e.path == "wallpaper/default_wallpaper.jpg")
        .unwrap();
    assert_eq!(
        wallpaper.blob.compression, Stored,
        "per-entry compression is kept"
    );
}

#[test]
fn edits_inside_component_rebuild_only_that_component() {
    let mut project = open();
    project
        .put_file(
            "icons!/res/drawable-xxhdpi/com.android.camera.png",
            b"new camera".to_vec(),
            "Replace",
        )
        .unwrap();
    project
        .put_file(
            "icons!/res/drawable-xxhdpi/com.miui.gallery.png",
            b"gallery".to_vec(),
            "Add",
        )
        .unwrap();
    let exported = export(&project);
    let after = read_package(&exported, "b", Limits::default()).unwrap();
    let (_, _, children) = after.nested.iter().find(|n| n.0 == "icons").unwrap();
    let names: Vec<_> = children.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "res/drawable-xxhdpi/com.android.camera.png",
            "res/drawable-xxhdpi/com.android.contacts.png",
            "res/drawable-xxhdpi/com.miui.gallery.png"
        ]
    );
    assert_eq!(children[0].blob.data, b"new camera");
}

#[test]
fn undo_redo_and_dirty_tracking() {
    let mut project = open();
    project
        .put_file(
            "wallpaper/default_wallpaper.jpg",
            b"v2".to_vec(),
            "Replace wallpaper",
        )
        .unwrap();
    assert!(project.is_dirty());
    project.delete(&["unknown".into()]).unwrap();
    assert!(!project.files.contains_key("unknown/vendor.bin"));
    assert_eq!(project.undo().unwrap(), "Delete unknown");
    assert!(project.files.contains_key("unknown/vendor.bin"));
    assert_eq!(project.undo().unwrap(), "Replace wallpaper");
    assert_eq!(
        project.files["wallpaper/default_wallpaper.jpg"].data,
        b"jpg"
    );
    assert!(
        !project.is_dirty(),
        "undoing back to the saved state is clean"
    );
    project.redo().unwrap();
    assert_eq!(project.files["wallpaper/default_wallpaper.jpg"].data, b"v2");
    assert!(project.undo().is_ok());
    assert!(project.undo().is_err());
}

#[test]
fn goto_history_step() {
    let mut project = open();
    project.put_file("a.txt", b"1".to_vec(), "one").unwrap();
    project.put_file("b.txt", b"2".to_vec(), "two").unwrap();
    project.put_file("c.txt", b"3".to_vec(), "three").unwrap();
    let first = project.history.undo[0].id;
    project.goto(Some(first)).unwrap();
    assert!(project.files.contains_key("a.txt") && !project.files.contains_key("b.txt"));
    let last = project.history.redo[0].id;
    project.goto(Some(last)).unwrap();
    assert!(project.files.contains_key("c.txt"));
    project.goto(None).unwrap();
    assert!(!project.files.contains_key("a.txt"));
}

#[test]
fn rename_move_duplicate() {
    let mut project = open();
    let renamed = project
        .rename("wallpaper/default_wallpaper.jpg", "home.jpg")
        .unwrap();
    assert_eq!(renamed, "wallpaper/home.jpg");
    project
        .move_to_folder(&["wallpaper/home.jpg".into()], "preview")
        .unwrap();
    assert!(project.files.contains_key("preview/home.jpg"));
    let copies = project.duplicate(&["preview/home.jpg".into()]).unwrap();
    assert_eq!(copies, vec!["preview/home copy.jpg".to_string()]);
    // Renaming a folder moves everything under it.
    project.rename("preview", "previews").unwrap();
    assert!(project.files.contains_key("previews/home copy.jpg"));
    // Renaming a component archive moves its children.
    project.rename("icons", "icons_old").unwrap();
    assert!(project.is_container("icons_old"));
    assert!(project
        .files
        .contains_key("icons_old!/res/drawable-xxhdpi/com.android.camera.png"));
    project.undo().unwrap();
    assert!(project.is_container("icons") && !project.is_container("icons_old"));
}

#[test]
fn rejects_conflicts_and_unsafe_targets() {
    let mut project = open();
    assert_eq!(
        project
            .rename("unknown/vendor.bin", "../x")
            .err()
            .unwrap()
            .code,
        "invalid"
    );
    project
        .put_file("wallpaper/b.jpg", b"b".to_vec(), "add")
        .unwrap();
    assert_eq!(
        project
            .rename("wallpaper/b.jpg", "default_wallpaper.jpg")
            .err()
            .unwrap()
            .code,
        "conflict"
    );
    assert_eq!(
        project
            .put_file("wallpaper", b"x".to_vec(), "x")
            .err()
            .unwrap()
            .code,
        "conflict"
    );
    assert_eq!(
        project
            .put_file("missing!/a.png", b"x".to_vec(), "x")
            .err()
            .unwrap()
            .code,
        "not_found"
    );
    assert_eq!(
        project
            .put_file("icons/a.png", b"x".to_vec(), "x")
            .err()
            .unwrap()
            .code,
        "conflict"
    );
    assert!(project
        .move_to_folder(&["wallpaper".into()], "wallpaper/sub")
        .is_err());
    // Failed operations leave no partial changes behind.
    assert!(project.files.contains_key("wallpaper/b.jpg"));
}

#[test]
fn add_files_conflict_policies() {
    let mut project = open();
    let items = vec![(
        "wallpaper/default_wallpaper.jpg".to_string(),
        b"new".to_vec(),
    )];
    let skipped = project
        .add_files(items.clone(), ConflictPolicy::Skip, "add")
        .unwrap();
    assert_eq!(skipped.skipped.len(), 1);
    let renamed = project
        .add_files(items.clone(), ConflictPolicy::Rename, "add")
        .unwrap();
    assert_eq!(
        renamed.written,
        vec!["wallpaper/default_wallpaper copy.jpg".to_string()]
    );
    let overwritten = project
        .add_files(items, ConflictPolicy::Overwrite, "add")
        .unwrap();
    assert_eq!(overwritten.overwritten.len(), 1);
    assert_eq!(
        project.files["wallpaper/default_wallpaper.jpg"].data,
        b"new"
    );
}

#[test]
fn pack_folder_into_component() {
    let mut project = Project::new_empty("T");
    project
        .put_file("framework-res/res/drawable/a.png", b"a".to_vec(), "add")
        .unwrap();
    project.pack_folder("framework-res").unwrap();
    assert!(project.is_container("framework-res"));
    assert!(project
        .files
        .contains_key("framework-res!/res/drawable/a.png"));
    let exported = export(&project);
    let read = read_package(&exported, "t", Limits::default()).unwrap();
    assert_eq!(read.nested[0].0, "framework-res");
}

#[test]
fn copy_from_reference_creates_components_and_attribution() {
    let reference = open();
    let mut project = Project::new_empty("Mine");
    let plan = project
        .plan_copy(&reference, &["icons".into()], None)
        .unwrap();
    assert_eq!(plan.len(), 2);
    let result = project
        .copy_from(&reference, &["icons".into()], None, ConflictPolicy::Skip)
        .unwrap();
    assert_eq!(result.written.len(), 2);
    assert!(project.is_container("icons"));
    assert_eq!(project.attributions[0].source_title, "Sample");
    // Copying into a folder flattens the component prefix.
    let into = project
        .plan_copy(
            &reference,
            &["icons!/res/drawable-xxhdpi/com.android.camera.png".into()],
            Some("extras"),
        )
        .unwrap();
    assert_eq!(into[0].destination, "extras/com.android.camera.png");
    // Second copy conflicts.
    let again = project
        .copy_from(&reference, &["icons".into()], None, ConflictPolicy::Skip)
        .unwrap();
    assert_eq!(again.skipped.len(), 2);
}

#[test]
fn new_project_is_dirty_until_saved() {
    let mut project = Project::new_empty("New");
    assert!(project.is_dirty());
    project.mark_saved(project.history.top(), Some(PathBuf::from("C:/x/New.mtz")));
    assert!(!project.is_dirty());
    assert_eq!(project.name, "New.mtz");
}

#[test]
fn place_file_replaces_same_stem_and_records_source() {
    let mut project = Project::from_bytes(&sample_package(), "s.mtz", None, Limits::default()).unwrap();
    assert!(project.files.contains_key("wallpaper/default_wallpaper.jpg"));
    let path = project
        .place_file(
            "wallpaper/default_wallpaper",
            "PNG",
            b"\x89PNG new".to_vec(),
            "Use wallpaper",
            Some(("Sky".into(), "Ann".into(), "Theme store · w-1".into())),
        )
        .unwrap();
    assert_eq!(path, "wallpaper/default_wallpaper.png");
    assert!(!project.files.contains_key("wallpaper/default_wallpaper.jpg"), "old extension removed");
    assert_eq!(project.attributions.last().unwrap().source_title, "Sky");
    project.undo().unwrap();
    assert!(project.files.contains_key("wallpaper/default_wallpaper.jpg"));
    assert!(!project.files.contains_key("wallpaper/default_wallpaper.png"));
    // New folders work too.
    let sound = project.place_file("ringtones/ringtone", "mp3", b"ID3".to_vec(), "Use ringtone", None).unwrap();
    assert_eq!(sound, "ringtones/ringtone.mp3");
}
