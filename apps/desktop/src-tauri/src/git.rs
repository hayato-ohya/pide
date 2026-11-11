//! Git integration via libgit2 (git2 crate).  Read-mostly: status, log,
//! diffs, staging, committing, conflict resolution; network ops via the git CLI.

use std::path::{Path, PathBuf};

use git2::{BranchType, DiffOptions, Oid, Repository, Sort, StatusOptions};
use serde::Serialize;

fn open(cwd: &str) -> Result<Repository, String> {
    Repository::discover(cwd).map_err(|e| format!("not a git repository: {}", e.message()))
}

fn rel(repo: &Repository, path: &str) -> PathBuf {
    let root = repo.workdir().unwrap_or_else(|| repo.path());
    let root_c = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let p = Path::new(path);
    let p_c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let r = p_c.strip_prefix(&root_c).or_else(|_| p.strip_prefix(root)).map(|x| x.to_path_buf()).unwrap_or_else(|_| PathBuf::from(path));
    // Index / pathspec paths always use '/', also on Windows.
    PathBuf::from(r.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/"))
}

fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    repo.workdir().map(|p| p.to_path_buf()).ok_or_else(|| "bare repository has no working tree".to_string())
}

#[derive(Serialize)]
pub struct StatusEntry {
    path: String,
    /// Previous path of a renamed file (staged renames only).
    old_path: Option<String>,
    /// "staged" | "unstaged" | "untracked" | "conflicted"
    area: &'static str,
    /// M A D R T ? U
    code: String,
}

#[derive(Serialize)]
pub struct GitStatus {
    /// "clean" | "merge" | "rebase" | "cherrypick" | "revert" | "bisect" | "other"
    state: &'static str,
    root: String,
    branch: Option<String>,
    head: Option<String>,
    detached: bool,
    ahead: usize,
    behind: usize,
    upstream: Option<String>,
    entries: Vec<StatusEntry>,
}

#[tauri::command(async)]
pub fn git_status(cwd: String) -> Result<GitStatus, String> {
    let repo = open(&cwd)?;
    let root = repo.workdir().map(|p| p.to_string_lossy().trim_end_matches('/').to_string()).unwrap_or_default();
    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand().map(|s| s.to_string()));
    let head_oid = head.as_ref().and_then(|h| h.target()).map(|o| o.to_string());
    let detached = repo.head_detached().unwrap_or(false);

    let (mut ahead, mut behind, mut upstream) = (0, 0, None);
    if let (Some(b), Some(h)) = (branch.as_ref(), head.as_ref().and_then(|h| h.target())) {
        if let Ok(local) = repo.find_branch(b, BranchType::Local) {
            if let Ok(up) = local.upstream() {
                upstream = up.name().ok().flatten().map(|s| s.to_string());
                if let Some(uo) = up.get().target() {
                    if let Ok((a, bh)) = repo.graph_ahead_behind(h, uo) {
                        ahead = a;
                        behind = bh;
                    }
                }
            }
        }
    }

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false).renames_head_to_index(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.message().to_string())?;
    let mut entries = vec![];
    for e in statuses.iter() {
        let s = e.status();
        // With rename detection `e.path()` is the OLD path; show/act on the new one.
        let new_path = |d: Option<git2::DiffDelta>| d.and_then(|d| d.new_file().path().map(|p| p.to_string_lossy().to_string()));
        let path = new_path(e.head_to_index()).or_else(|| new_path(e.index_to_workdir())).or_else(|| e.path().map(|p| p.to_string())).unwrap_or_default();
        let old_path = e.head_to_index().filter(|_| s.is_index_renamed()).and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()));
        if s.is_conflicted() {
            entries.push(StatusEntry { path: path.clone(), old_path: None, area: "conflicted", code: "U".into() });
            continue;
        }
        if s.is_index_new() || s.is_index_modified() || s.is_index_deleted() || s.is_index_renamed() || s.is_index_typechange() {
            let code = if s.is_index_new() { "A" } else if s.is_index_deleted() { "D" } else if s.is_index_renamed() { "R" } else { "M" };
            entries.push(StatusEntry { path: path.clone(), old_path, area: "staged", code: code.into() });
        }
        if s.is_wt_new() {
            entries.push(StatusEntry { path: path.clone(), old_path: None, area: "untracked", code: "?".into() });
        } else if s.is_wt_modified() || s.is_wt_deleted() || s.is_wt_renamed() || s.is_wt_typechange() {
            let code = if s.is_wt_deleted() { "D" } else if s.is_wt_renamed() { "R" } else { "M" };
            entries.push(StatusEntry { path, old_path: None, area: "unstaged", code: code.into() });
        }
    }
    Ok(GitStatus { state: repo_state(&repo), root, branch, head: head_oid, detached, ahead, behind, upstream, entries })
}

#[derive(Serialize)]
pub struct Commit {
    id: String,
    short: String,
    parents: Vec<String>,
    summary: String,
    body: String,
    author: String,
    email: String,
    time: i64,
    refs: Vec<String>,
}

#[tauri::command(async)]
pub fn git_log(cwd: String, limit: usize, all: bool) -> Result<Vec<Commit>, String> {
    let repo = open(&cwd)?;
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.message().to_string())?;
    if all {
        walk.push_glob("refs/heads/*").ok();
        walk.push_glob("refs/remotes/*").ok();
        walk.push_glob("refs/tags/*").ok();
    }
    if walk.push_head().is_err() && !all {
        return Ok(vec![]);
    }
    // ref labels per commit
    let mut labels: std::collections::HashMap<Oid, Vec<String>> = Default::default();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            if let (Some(name), Some(_)) = (r.shorthand(), r.target()) {
                if name == "HEAD" { continue; }
                // Annotated tags: target() is the tag object; label the commit it points to.
                let Some(oid) = r.peel_to_commit().ok().map(|c| c.id()) else { continue };
                labels.entry(oid).or_default().push(name.to_string());
            }
        }
    }
    let head = repo.head().ok().and_then(|h| h.target());
    let mut out = vec![];
    for oid in walk.flatten().take(limit) {
        let c = match repo.find_commit(oid) { Ok(c) => c, Err(_) => continue };
        let mut refs = labels.get(&oid).cloned().unwrap_or_default();
        if Some(oid) == head { refs.insert(0, "HEAD".into()); }
        out.push(Commit {
            id: oid.to_string(),
            short: oid.to_string()[..7].to_string(),
            parents: c.parent_ids().map(|p| p.to_string()).collect(),
            summary: c.summary().unwrap_or("").to_string(),
            body: c.body().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            email: c.author().email().unwrap_or("").to_string(),
            time: c.time().seconds(),
            refs,
        });
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct FileDiff {
    path: String,
    old_path: Option<String>,
    /// A M D R
    code: String,
    old: Option<String>,
    new: Option<String>,
    binary: bool,
    additions: usize,
    deletions: usize,
}

fn repo_state(repo: &Repository) -> &'static str {
    use git2::RepositoryState as S;
    match repo.state() {
        S::Clean => "clean",
        S::Merge => "merge",
        S::Rebase | S::RebaseInteractive | S::RebaseMerge => "rebase",
        S::CherryPick | S::CherryPickSequence => "cherrypick",
        S::Revert | S::RevertSequence => "revert",
        S::Bisect => "bisect",
        _ => "other",
    }
}

fn blob_text(repo: &Repository, oid: Oid) -> Option<String> {
    let b = repo.find_blob(oid).ok()?;
    if b.is_binary() { return None; }
    Some(String::from_utf8_lossy(b.content()).to_string())
}

const MAX_DIFF_TEXT: u64 = 4 * 1024 * 1024;
/// Line statistics are skipped for files larger than this (keeps status refresh fast).
const MAX_STAT_SIZE: u64 = 2 * 1024 * 1024;

/// `core.autocrlf` is true/input: the index side is LF, so CRLF is normalised for display.
fn normalize_eol(repo: &Repository) -> bool {
    match repo.config().and_then(|c| c.get_string("core.autocrlf")) {
        Ok(v) => matches!(v.to_ascii_lowercase().as_str(), "true" | "input"),
        Err(_) => false,
    }
}

/// Build a `FileDiff` list.  With `only`, just the delta whose new path matches is kept.
fn collect(repo: &Repository, diff: &git2::Diff, workdir_new: bool, with_content: bool, only: Option<&str>) -> Vec<FileDiff> {
    let mut out = vec![];
    let root = repo.workdir().map(|p| p.to_path_buf());
    let eol = with_content && normalize_eol(repo);
    let norm = |t: String| if eol { t.replace("\r\n", "\n") } else { t };
    for (i, d) in diff.deltas().enumerate() {
        let newp = d.new_file().path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if only.is_some_and(|o| o != newp) { continue; }
        let oldp = d.old_file().path().map(|p| p.to_string_lossy().to_string());
        let code = match d.status() {
            git2::Delta::Added | git2::Delta::Untracked => "A",
            git2::Delta::Deleted => "D",
            git2::Delta::Renamed => "R",
            _ => "M",
        };
        let mut binary = d.flags().is_binary();
        let too_big = d.old_file().size() > MAX_DIFF_TEXT || d.new_file().size() > MAX_DIFF_TEXT;
        if too_big { binary = true; }
        let (old, new) = if !with_content || binary {
            (None, None)
        } else {
            let old = if d.old_file().id().is_zero() { None } else { blob_text(repo, d.old_file().id()) };
            let new = if workdir_new {
                root.as_ref().and_then(|r| {
                    let p = r.join(&newp);
                    let md = std::fs::metadata(&p).ok()?;
                    if md.len() > MAX_DIFF_TEXT { return None; }
                    std::fs::read(p).ok()
                }).and_then(|b| if b.contains(&0) { None } else { Some(String::from_utf8_lossy(&b).to_string()) })
            } else if d.new_file().id().is_zero() { None } else { blob_text(repo, d.new_file().id()) };
            (old.map(norm), new.map(norm))
        };
        let (mut additions, mut deletions) = (0, 0);
        let big_stat = d.old_file().size() > MAX_STAT_SIZE || d.new_file().size() > MAX_STAT_SIZE;
        if !binary && !big_stat {
            if let Ok(Some(p)) = git2::Patch::from_diff(diff, i) {
                if let Ok((_, a, dl)) = p.line_stats() { additions = a; deletions = dl; }
            }
        }
        out.push(FileDiff { path: newp, old_path: oldp.filter(|_| code == "R"), code: code.into(), old, new, binary, additions, deletions });
    }
    out
}

/// Diff of the working tree vs index (unstaged), or index vs HEAD (staged).
#[tauri::command(async)]
pub fn git_diff(cwd: String, staged: bool, path: Option<String>) -> Result<Vec<FileDiff>, String> {
    let repo = open(&cwd)?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).disable_pathspec_match(true);
    // Untracked content (and file text in general) is only read for a single requested path.
    let with_content = path.is_some();
    opts.show_untracked_content(with_content);
    let only = path.as_ref().map(|p| rel(&repo, p).to_string_lossy().to_string());
    // Staged diffs are filtered after rename detection (a pathspec would hide the old path).
    if !staged { if let Some(o) = &only { opts.pathspec(o); } }
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut diff = if staged {
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
    .map_err(|e| e.message().to_string())?;
    if staged { let _ = diff.find_similar(Some(git2::DiffFindOptions::new().renames(true))); }
    Ok(collect(&repo, &diff, !staged, with_content, if staged { only.as_deref() } else { None }))
}

/// Files changed by a commit (vs its first parent), with line stats only.
#[tauri::command(async)]
pub fn git_commit_diff(cwd: String, id: String) -> Result<Vec<FileDiff>, String> {
    let repo = open(&cwd)?;
    let oid = Oid::from_str(&id).map_err(|e| e.message().to_string())?;
    let c = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
    let tree = c.tree().map_err(|e| e.message().to_string())?;
    let parent = c.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    let mut diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts)).map_err(|e| e.message().to_string())?;
    let _ = diff.find_similar(Some(git2::DiffFindOptions::new().renames(true)));
    Ok(collect(&repo, &diff, false, false, None))
}

/// Full text of one file in a commit diff (vs first parent).
#[tauri::command(async)]
pub fn git_commit_file(cwd: String, id: String, path: String) -> Result<Option<FileDiff>, String> {
    let repo = open(&cwd)?;
    let oid = Oid::from_str(&id).map_err(|e| e.message().to_string())?;
    let c = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
    let tree = c.tree().map_err(|e| e.message().to_string())?;
    let parent = c.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    let mut diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts)).map_err(|e| e.message().to_string())?;
    let _ = diff.find_similar(Some(git2::DiffFindOptions::new().renames(true)));
    Ok(collect(&repo, &diff, false, true, Some(&path)).into_iter().next())
}

#[tauri::command(async)]
pub fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open(&cwd)?;
    let mut idx = repo.index().map_err(|e| e.message().to_string())?;
    for p in paths {
        let r = rel(&repo, &p);
        let abs = workdir(&repo)?.join(&r);
        if abs.exists() { idx.add_path(&r).map_err(|e| e.message().to_string())?; } else { idx.remove_path(&r).map_err(|e| e.message().to_string())?; }
    }
    idx.write().map_err(|e| e.message().to_string())
}

#[tauri::command(async)]
pub fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open(&cwd)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut idx = repo.index().map_err(|e| e.message().to_string())?;
    // Written entry by entry (no pathspec), so `*`, `?`, `[` in names cannot over-match.
    for p in &paths {
        let r = rel(&repo, p);
        match head_tree.as_ref().and_then(|t| t.get_path(&r).ok()) {
            Some(te) => {
                let path = r.to_string_lossy().as_bytes().to_vec();
                let entry = git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: te.filemode() as u32,
                    uid: 0,
                    gid: 0,
                    file_size: 0,
                    id: te.id(),
                    flags: path.len().min(0xFFF) as u16,
                    flags_extended: 0,
                    path,
                };
                idx.add(&entry).map_err(|e| e.message().to_string())?;
            }
            None => { let _ = idx.remove_path(&r); }
        }
    }
    idx.write().map_err(|e| e.message().to_string())
}

/// Discard working-tree changes of a file (checkout from index).
#[tauri::command(async)]
pub fn git_discard(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open(&cwd)?;
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force().disable_pathspec_match(true);
    for p in &paths { cb.path(rel(&repo, p)); }
    repo.checkout_index(None, Some(&mut cb)).map_err(|e| e.message().to_string())
}

#[tauri::command(async)]
pub fn git_commit(cwd: String, message: String, amend: bool) -> Result<String, String> {
    let repo = open(&cwd)?;
    if repo.state() != git2::RepositoryState::Clean {
        return Err("a merge / rebase / cherry-pick / revert is in progress: resolve conflicts and use Continue instead of Commit".into());
    }
    let sig = repo.signature().map_err(|e| format!("git identity not configured: {}", e.message()))?;
    let mut idx = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = idx.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let oid = if amend {
        let h = head.ok_or("nothing to amend")?;
        // An empty message keeps the original one.
        let msg = if message.trim().is_empty() { None } else { Some(message.as_str()) };
        h.amend(Some("HEAD"), None, Some(&sig), None, msg, Some(&tree)).map_err(|e| e.message().to_string())?
    } else {
        if head.as_ref().map_or(tree.is_empty(), |h| h.tree_id() == tree_oid) {
            return Err("nothing to commit (staged tree is identical to HEAD)".into());
        }
        let parents: Vec<&git2::Commit> = head.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents).map_err(|e| e.message().to_string())?
    };
    Ok(oid.to_string())
}

#[derive(Serialize)]
pub struct Branch { name: String, remote: bool, current: bool }

#[tauri::command(async)]
pub fn git_branches(cwd: String) -> Result<Vec<Branch>, String> {
    let repo = open(&cwd)?;
    let mut out = vec![];
    for b in repo.branches(None).map_err(|e| e.message().to_string())?.flatten() {
        let (br, kind) = b;
        if let Ok(Some(name)) = br.name() {
            out.push(Branch { name: name.to_string(), remote: kind == BranchType::Remote, current: br.is_head() });
        }
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn git_checkout(cwd: String, name: String) -> Result<(), String> {
    let repo = open(&cwd)?;
    let (mut obj, reference) = repo.revparse_ext(&name).map_err(|e| e.message().to_string())?;
    let mut head_ref = reference.as_ref().map(|r| r.name().map(|n| n.to_string()).ok_or("reference name is not valid UTF-8")).transpose()?;
    if let Some(r) = reference.as_ref().filter(|r| r.is_remote()) {
        // Remote-tracking branch: check out (creating if needed) a local branch tracking it.
        let short = r.shorthand().ok_or("reference name is not valid UTF-8")?.to_string();
        let local = short.split_once('/').map(|(_, l)| l.to_string()).ok_or_else(|| format!("unexpected remote branch name {short:?}"))?;
        if repo.find_branch(&local, BranchType::Local).is_err() {
            let commit = r.peel_to_commit().map_err(|e| e.message().to_string())?;
            let mut b = repo.branch(&local, &commit, false).map_err(|e| e.message().to_string())?;
            b.set_upstream(Some(&short)).map_err(|e| e.message().to_string())?;
        }
        let lref = format!("refs/heads/{local}");
        obj = repo.revparse_single(&lref).map_err(|e| e.message().to_string())?;
        head_ref = Some(lref);
    }
    repo.checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().safe())).map_err(|e| e.message().to_string())?;
    match head_ref {
        Some(r) => repo.set_head(&r).map_err(|e| e.message().to_string()),
        None => repo.set_head_detached(obj.id()).map_err(|e| e.message().to_string()),
    }
}

#[tauri::command(async)]
pub fn git_create_branch(cwd: String, name: String) -> Result<(), String> {
    let repo = open(&cwd)?;
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(|e| e.message().to_string())?;
    repo.branch(&name, &head, false).map_err(|e| e.message().to_string())?;
    git_checkout(cwd, name)
}

#[tauri::command(async)]
pub fn git_init(cwd: String) -> Result<(), String> {
    Repository::init(&cwd).map(|_| ()).map_err(|e| e.message().to_string())
}

// ---------------------------------------------------------- conflicts ----

#[derive(Serialize)]
pub struct Conflict {
    path: String,
    /// Common ancestor, "ours" (HEAD side), "theirs" (merged side); None when that side deleted the file or it is binary.
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
    /// Current working-tree text (with conflict markers), None if missing/binary/too large.
    workdir: Option<String>,
    binary: bool,
}

fn conflict_entry<'a>(repo: &'a Repository, idx: &'a git2::Index, path: &Path) -> Result<git2::IndexConflict, String> {
    let want = path.to_string_lossy().to_string();
    for c in idx.conflicts().map_err(|e| e.message().to_string())?.flatten() {
        let p = c.our.as_ref().or(c.their.as_ref()).or(c.ancestor.as_ref()).map(|e| String::from_utf8_lossy(&e.path).to_string());
        if p.as_deref() == Some(want.as_str()) {
            return Ok(c);
        }
    }
    let _ = repo;
    Err(format!("{want} has no conflict in the index"))
}

#[tauri::command(async)]
pub fn git_conflict(cwd: String, path: String) -> Result<Conflict, String> {
    let repo = open(&cwd)?;
    let r = rel(&repo, &path);
    let idx = repo.index().map_err(|e| e.message().to_string())?;
    let c = conflict_entry(&repo, &idx, &r)?;
    let side = |e: &Option<git2::IndexEntry>| e.as_ref().map(|e| e.id);
    let (b, o, t) = (side(&c.ancestor), side(&c.our), side(&c.their));
    let binary = [b, o, t].iter().flatten().any(|oid| repo.find_blob(*oid).map(|bl| bl.is_binary()).unwrap_or(false));
    let abs = workdir(&repo)?.join(&r);
    let workdir = match std::fs::metadata(&abs) {
        Ok(m) if m.len() <= MAX_DIFF_TEXT => std::fs::read(&abs).ok().map(|v| String::from_utf8_lossy(&v).to_string()),
        _ => None,
    };
    Ok(Conflict {
        path: r.to_string_lossy().to_string(),
        base: b.and_then(|o| blob_text(&repo, o)),
        ours: o.and_then(|o| blob_text(&repo, o)),
        theirs: t.and_then(|o| blob_text(&repo, o)),
        workdir,
        binary,
    })
}

/// Resolve a conflicted path: `side` is "ours" | "theirs" (write that version to the
/// working tree) or "workdir" (keep the file as edited).  The path is then staged,
/// which clears its conflict stages.  Unless `allow_markers`, a working-tree file
/// that still contains `<<<<<<<` markers is rejected.
#[tauri::command(async)]
pub fn git_resolve(cwd: String, path: String, side: String, allow_markers: bool) -> Result<(), String> {
    let repo = open(&cwd)?;
    let r = rel(&repo, &path);
    let mut idx = repo.index().map_err(|e| e.message().to_string())?;
    let c = conflict_entry(&repo, &idx, &r)?;
    let abs = workdir(&repo)?.join(&r);
    match side.as_str() {
        "ours" | "theirs" => {
            let have = if side == "ours" { c.our.is_some() } else { c.their.is_some() };
            if have {
                // libgit2 checkout applies filters (eol/autocrlf), executable bit and symlinks.
                let mut cb = git2::build::CheckoutBuilder::new();
                cb.force().disable_pathspec_match(true).path(&r);
                if side == "ours" { cb.use_ours(true); } else { cb.use_theirs(true); }
                repo.checkout_index(Some(&mut idx), Some(&mut cb)).map_err(|e| e.message().to_string())?;
            } else {
                let _ = std::fs::remove_file(&abs);
            }
        }
        "workdir" => {
            if !allow_markers && abs.exists() {
                let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
                let text = String::from_utf8_lossy(&bytes);
                if text.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ") || l == "=======") {
                    return Err("file still contains conflict markers".into());
                }
            }
        }
        _ => return Err(format!("unknown side {side:?}")),
    }
    if abs.exists() { idx.add_path(&r).map_err(|e| e.message().to_string())?; } else { idx.remove_path(&r).map_err(|e| e.message().to_string())?; }
    idx.write().map_err(|e| e.message().to_string())
}

fn valid_ref(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) || name.contains("..") {
        return Err(format!("invalid ref name {name:?}"));
    }
    Ok(())
}

/// `git merge --no-edit <branch>`; a conflict leaves the repo in the "merge" state.
#[tauri::command]
pub async fn git_merge(cwd: String, branch: String) -> Result<CmdResult, String> {
    valid_ref(&branch)?;
    run_git(&cwd, &["merge", "--no-edit", "--", &branch]).await
}

/// Abort the in-progress merge / rebase / cherry-pick / revert.
#[tauri::command]
pub async fn git_abort(cwd: String) -> Result<CmdResult, String> {
    let state = { let repo = open(&cwd)?; repo_state(&repo) };
    let op = match state {
        "merge" => "merge",
        "rebase" => "rebase",
        "cherrypick" => "cherry-pick",
        "revert" => "revert",
        other => return Err(format!("nothing to abort (state: {other})")),
    };
    run_git(&cwd, &[op, "--abort"]).await
}

/// Continue the in-progress operation once every conflict is staged.
#[tauri::command]
pub async fn git_continue(cwd: String) -> Result<CmdResult, String> {
    let state = { let repo = open(&cwd)?; repo_state(&repo) };
    let op = match state {
        "merge" => "merge",
        "rebase" => "rebase",
        "cherrypick" => "cherry-pick",
        "revert" => "revert",
        other => return Err(format!("nothing to continue (state: {other})")),
    };
    run_git(&cwd, &[op, "--continue"]).await
}

// ------------------------------------------------------------ network ----
// fetch / pull / push go through the git CLI so the user's SSH agent and
// credential helpers work unchanged (libgit2 would need its own callbacks).

#[derive(Serialize)]
pub struct CmdResult {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

async fn run_git(cwd: &str, args: &[&str]) -> Result<CmdResult, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0") // never hang on a password prompt
        .env("GIT_EDITOR", "true") // merge/rebase --continue must not open an editor
        .kill_on_drop(true); // on timeout, don't leave git/ssh running with index.lock held
    // Fail instead of prompting for an ssh passphrase, unless the user configured their own ssh command.
    let user_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || open(cwd).ok().and_then(|r| r.config().ok()).is_some_and(|c| c.get_string("core.sshCommand").is_ok());
    if !user_ssh {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    kernel_client::platform::quiet(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
    .await
    .map_err(|_| "git timed out after 300 s".to_string())?
    .map_err(|e| format!("git: {e}"))?;
    Ok(CmdResult {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

#[tauri::command]
pub async fn git_fetch(cwd: String) -> Result<CmdResult, String> {
    run_git(&cwd, &["fetch", "--all", "--prune"]).await
}

#[tauri::command]
pub async fn git_pull(cwd: String, rebase: bool) -> Result<CmdResult, String> {
    let mode = if rebase { "--rebase" } else { "--ff-only" };
    run_git(&cwd, &["pull", mode]).await
}

#[tauri::command]
pub async fn git_push(cwd: String, set_upstream: Option<String>, force: bool) -> Result<CmdResult, String> {
    let mut args = vec!["push"];
    if force {
        args.push("--force-with-lease");
    }
    let (branch, remote);
    if let Some(b) = set_upstream {
        if b.starts_with('-') || b.contains(char::is_whitespace) || b.is_empty() {
            return Err(format!("invalid branch name {b:?}"));
        }
        remote = {
            let repo = open(&cwd)?;
            let configured = repo.config().ok().and_then(|c| c.get_string(&format!("branch.{b}.remote")).ok()).filter(|r| !r.is_empty() && r != ".");
            let names: Vec<String> = repo.remotes().map_err(|e| e.message().to_string())?.iter().flatten().map(|s| s.to_string()).collect();
            match configured {
                Some(r) => r,
                None if names.iter().any(|n| n == "origin") => "origin".to_string(),
                None if names.len() == 1 => names[0].clone(),
                None => return Err("no remote to publish to (configure branch.<name>.remote or add 'origin')".into()),
            }
        };
        branch = b;
        args.extend(["-u", remote.as_str(), branch.as_str()]);
    }
    run_git(&cwd, &args).await
}

#[derive(Serialize)]
pub struct Remote { name: String, url: String }

#[tauri::command(async)]
pub fn git_remotes(cwd: String) -> Result<Vec<Remote>, String> {
    let repo = open(&cwd)?;
    let names = repo.remotes().map_err(|e| e.message().to_string())?;
    Ok(names.iter().flatten().filter_map(|n| repo.find_remote(n).ok().map(|r| Remote { name: n.to_string(), url: r.url().unwrap_or("").to_string() })).collect())
}

#[tauri::command(async)]
pub fn git_add_remote(cwd: String, name: String, url: String) -> Result<(), String> {
    let repo = open(&cwd)?;
    repo.remote(&name, &url).map(|_| ()).map_err(|e| e.message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_commit_amend_checkout() {
        let dir = std::env::temp_dir().join(format!("pide-gitcheck-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let repo = Repository::init(&cwd).unwrap();
        repo.config().unwrap().set_str("user.name", "t").unwrap();
        repo.config().unwrap().set_str("user.email", "t@e").unwrap();
        std::fs::write(dir.join("a.py"), "print(1)\n").unwrap();
        git_stage(cwd.clone(), vec![dir.join("a.py").to_string_lossy().to_string()]).unwrap();
        git_commit(cwd.clone(), "first".into(), false).unwrap();
        assert!(git_commit(cwd.clone(), "empty".into(), false).is_err());
        // rename shows the new path with old_path
        std::fs::rename(dir.join("a.py"), dir.join("b.py")).unwrap();
        git_stage(cwd.clone(), vec!["a.py".into(), "b.py".into()]).unwrap();
        let st = git_status(cwd.clone()).unwrap();
        let e = st.entries.iter().find(|e| e.area == "staged").unwrap();
        assert_eq!((e.path.as_str(), e.old_path.as_deref(), e.code.as_str()), ("b.py", Some("a.py"), "R"));
        // amend with empty message keeps it
        let id = git_commit(cwd.clone(), "  ".into(), true).unwrap();
        let c = repo.find_commit(Oid::from_str(&id).unwrap()).unwrap();
        assert_eq!(c.message(), Some("first"));
        // remote-tracking checkout creates a local branch
        repo.remote("origin", "/nonexistent").unwrap();
        repo.reference("refs/remotes/origin/feat", c.id(), false, "t").unwrap();
        git_checkout(cwd.clone(), "origin/feat".into()).unwrap();
        assert_eq!(repo.head().unwrap().name(), Some("refs/heads/feat"));
        assert!(!repo.head_detached().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_repo(name: &str) -> (PathBuf, String, Repository) {
        let dir = std::env::temp_dir().join(format!("pide-git-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let repo = Repository::init(&cwd).unwrap();
        repo.config().unwrap().set_str("user.name", "t").unwrap();
        repo.config().unwrap().set_str("user.email", "t@e").unwrap();
        (dir, cwd, repo)
    }

    #[test]
    fn rename_in_commit_diff() {
        let (dir, cwd, _repo) = temp_repo("rename");
        std::fs::write(dir.join("a.py"), "print(1)\nprint(2)\nprint(3)\n").unwrap();
        git_stage(cwd.clone(), vec!["a.py".into()]).unwrap();
        git_commit(cwd.clone(), "first".into(), false).unwrap();
        std::fs::rename(dir.join("a.py"), dir.join("b.py")).unwrap();
        git_stage(cwd.clone(), vec!["a.py".into(), "b.py".into()]).unwrap();
        // staged diff of the new path shows the rename
        let d = git_diff(cwd.clone(), true, Some("b.py".into())).unwrap();
        assert_eq!((d[0].code.as_str(), d[0].old_path.as_deref()), ("R", Some("a.py")));
        let id = git_commit(cwd.clone(), "move".into(), false).unwrap();
        let files = git_commit_diff(cwd.clone(), id.clone()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].path.as_str(), files[0].old_path.as_deref(), files[0].code.as_str()), ("b.py", Some("a.py"), "R"));
        let f = git_commit_file(cwd.clone(), id, "b.py".into()).unwrap().unwrap();
        assert_eq!(f.code, "R");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unstage_is_literal() {
        let (dir, cwd, repo) = temp_repo("unstage");
        // unborn HEAD: removes from index
        std::fs::write(dir.join("a[1].py"), "x\n").unwrap();
        std::fs::write(dir.join("a1.py"), "y\n").unwrap();
        git_stage(cwd.clone(), vec!["a[1].py".into(), "a1.py".into()]).unwrap();
        git_unstage(cwd.clone(), vec!["a[1].py".into()]).unwrap();
        let idx = repo.index().unwrap();
        assert!(idx.get_path(Path::new("a[1].py"), 0).is_none());
        assert!(idx.get_path(Path::new("a1.py"), 0).is_some());
        drop(idx);
        git_commit(cwd.clone(), "c".into(), false).unwrap();
        std::fs::write(dir.join("a[1].py"), "x2\n").unwrap();
        std::fs::write(dir.join("a1.py"), "y2\n").unwrap();
        git_stage(cwd.clone(), vec!["a[1].py".into(), "a1.py".into()]).unwrap();
        git_unstage(cwd.clone(), vec!["a[1].py".into()]).unwrap();
        let st = git_status(cwd.clone()).unwrap();
        let staged: Vec<&str> = st.entries.iter().filter(|e| e.area == "staged").map(|e| e.path.as_str()).collect();
        assert_eq!(staged, vec!["a1.py"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_file_has_no_stats() {
        let (dir, cwd, _repo) = temp_repo("large");
        std::fs::write(dir.join("big.txt"), "a\n").unwrap();
        git_stage(cwd.clone(), vec!["big.txt".into()]).unwrap();
        git_commit(cwd.clone(), "c".into(), false).unwrap();
        std::fs::write(dir.join("big.txt"), "line\n".repeat(500_000)).unwrap();
        let d = git_diff(cwd.clone(), false, None).unwrap();
        assert_eq!((d[0].additions, d[0].deletions), (0, 0));
        std::fs::write(dir.join("big.txt"), "b\n").unwrap();
        let d = git_diff(cwd.clone(), false, None).unwrap();
        assert_eq!((d[0].additions, d[0].deletions), (1, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_side_keeps_mode_and_stages() {
        let (dir, cwd, repo) = temp_repo("resolve");
        let base = {
            std::fs::write(dir.join("s.sh"), "base\n").unwrap();
            git_stage(cwd.clone(), vec!["s.sh".into()]).unwrap();
            git_commit(cwd.clone(), "base".into(), false).unwrap()
        };
        let main = repo.head().unwrap().shorthand().unwrap().to_string();
        let base_c = repo.find_commit(Oid::from_str(&base).unwrap()).unwrap();
        repo.branch("other", &base_c, false).unwrap();
        #[cfg(unix)]
        let chmod = || {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join("s.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        #[cfg(not(unix))]
        let chmod = || {};
        std::fs::write(dir.join("s.sh"), "main\n").unwrap();
        chmod();
        git_stage(cwd.clone(), vec!["s.sh".into()]).unwrap();
        git_commit(cwd.clone(), "main".into(), false).unwrap();
        git_checkout(cwd.clone(), "other".into()).unwrap();
        std::fs::write(dir.join("s.sh"), "other\n").unwrap();
        git_stage(cwd.clone(), vec!["s.sh".into()]).unwrap();
        git_commit(cwd.clone(), "other".into(), false).unwrap();
        // merge main into other -> conflict
        let ann = repo.find_annotated_commit(repo.find_branch(&main, BranchType::Local).unwrap().get().target().unwrap()).unwrap();
        repo.merge(&[&ann], None, None).unwrap();
        assert!(repo.index().unwrap().has_conflicts());
        git_resolve(cwd.clone(), "s.sh".into(), "theirs".into(), false).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("s.sh")).unwrap(), "main\n");
        let mut idx = repo.index().unwrap();
        idx.read(true).unwrap();
        assert!(!idx.has_conflicts());
        let e = idx.get_path(Path::new("s.sh"), 0).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(e.mode, 0o100755);
            assert_eq!(std::fs::metadata(dir.join("s.sh")).unwrap().permissions().mode() & 0o111, 0o111);
        }
        assert_eq!(repo.find_blob(e.id).unwrap().content(), b"main\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
