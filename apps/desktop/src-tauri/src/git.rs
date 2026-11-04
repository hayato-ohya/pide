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
    p_c.strip_prefix(&root_c).or_else(|_| p.strip_prefix(root)).map(|x| x.to_path_buf()).unwrap_or_else(|_| PathBuf::from(path))
}

fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    repo.workdir().map(|p| p.to_path_buf()).ok_or_else(|| "bare repository has no working tree".to_string())
}

#[derive(Serialize)]
pub struct StatusEntry {
    path: String,
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
        let path = e.path().unwrap_or("").to_string();
        if s.is_conflicted() {
            entries.push(StatusEntry { path: path.clone(), area: "conflicted", code: "U".into() });
            continue;
        }
        if s.is_index_new() || s.is_index_modified() || s.is_index_deleted() || s.is_index_renamed() || s.is_index_typechange() {
            let code = if s.is_index_new() { "A" } else if s.is_index_deleted() { "D" } else if s.is_index_renamed() { "R" } else { "M" };
            entries.push(StatusEntry { path: path.clone(), area: "staged", code: code.into() });
        }
        if s.is_wt_new() {
            entries.push(StatusEntry { path: path.clone(), area: "untracked", code: "?".into() });
        } else if s.is_wt_modified() || s.is_wt_deleted() || s.is_wt_renamed() || s.is_wt_typechange() {
            let code = if s.is_wt_deleted() { "D" } else if s.is_wt_renamed() { "R" } else { "M" };
            entries.push(StatusEntry { path, area: "unstaged", code: code.into() });
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
            if let (Some(name), Some(oid)) = (r.shorthand(), r.target()) {
                if name == "HEAD" { continue; }
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

fn collect(repo: &Repository, diff: &git2::Diff, workdir_new: bool, with_content: bool) -> Vec<FileDiff> {
    let mut out = vec![];
    let root = repo.workdir().map(|p| p.to_path_buf());
    for d in diff.deltas() {
        let newp = d.new_file().path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
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
            (old, new)
        };
        out.push(FileDiff { path: newp, old_path: oldp.filter(|_| code == "R"), code: code.into(), old, new, binary, additions: 0, deletions: 0 });
    }
    for (i, fd) in out.iter_mut().enumerate() {
        if let Ok(Some(p)) = git2::Patch::from_diff(diff, i) {
            if let Ok((_, a, d)) = p.line_stats() { fd.additions = a; fd.deletions = d; }
        }
    }
    out
}

/// Diff of the working tree vs index (unstaged), or index vs HEAD (staged).
#[tauri::command(async)]
pub fn git_diff(cwd: String, staged: bool, path: Option<String>) -> Result<Vec<FileDiff>, String> {
    let repo = open(&cwd)?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    // Untracked content (and file text in general) is only read for a single requested path.
    let with_content = path.is_some();
    opts.show_untracked_content(with_content);
    if let Some(p) = &path { opts.pathspec(rel(&repo, p)); }
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = if staged {
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
    .map_err(|e| e.message().to_string())?;
    Ok(collect(&repo, &diff, !staged, with_content))
}

/// Files changed by a commit (vs its first parent), with full old/new text.
#[tauri::command(async)]
pub fn git_commit_diff(cwd: String, id: String) -> Result<Vec<FileDiff>, String> {
    let repo = open(&cwd)?;
    let oid = Oid::from_str(&id).map_err(|e| e.message().to_string())?;
    let c = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
    let tree = c.tree().map_err(|e| e.message().to_string())?;
    let parent = c.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts)).map_err(|e| e.message().to_string())?;
    Ok(collect(&repo, &diff, false, false))
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
    opts.pathspec(&path);
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts)).map_err(|e| e.message().to_string())?;
    Ok(collect(&repo, &diff, false, true).into_iter().find(|f| f.path == path))
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
    let head = repo.head().ok().and_then(|h| h.peel(git2::ObjectType::Commit).ok());
    let specs: Vec<PathBuf> = paths.iter().map(|p| rel(&repo, p)).collect();
    match head {
        Some(obj) => repo.reset_default(Some(&obj), specs.iter()).map_err(|e| e.message().to_string()),
        None => {
            let mut idx = repo.index().map_err(|e| e.message().to_string())?;
            for s in specs { let _ = idx.remove_path(&s); }
            idx.write().map_err(|e| e.message().to_string())
        }
    }
}

/// Discard working-tree changes of a file (checkout from index).
#[tauri::command(async)]
pub fn git_discard(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open(&cwd)?;
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force();
    for p in &paths { cb.path(rel(&repo, p)); }
    repo.checkout_index(None, Some(&mut cb)).map_err(|e| e.message().to_string())
}

#[tauri::command(async)]
pub fn git_commit(cwd: String, message: String, amend: bool) -> Result<String, String> {
    let repo = open(&cwd)?;
    let sig = repo.signature().map_err(|e| format!("git identity not configured: {}", e.message()))?;
    let mut idx = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = idx.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let oid = if amend {
        let h = head.ok_or("nothing to amend")?;
        h.amend(Some("HEAD"), None, None, None, Some(&message), Some(&tree)).map_err(|e| e.message().to_string())?
    } else {
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
    let (obj, reference) = repo.revparse_ext(&name).map_err(|e| e.message().to_string())?;
    repo.checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().safe())).map_err(|e| e.message().to_string())?;
    match reference {
        Some(r) => repo.set_head(r.name().unwrap()).map_err(|e| e.message().to_string()),
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
            let e = if side == "ours" { &c.our } else { &c.their };
            match e {
                Some(e) => {
                    let blob = repo.find_blob(e.id).map_err(|e| e.message().to_string())?;
                    if let Some(parent) = abs.parent() { let _ = std::fs::create_dir_all(parent); }
                    std::fs::write(&abs, blob.content()).map_err(|e| e.to_string())?;
                }
                None => { let _ = std::fs::remove_file(&abs); }
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
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0") // never hang on a password prompt
            .env("GIT_EDITOR", "true") // merge/rebase --continue must not open an editor
            .env("GIT_SSH_COMMAND", std::env::var("GIT_SSH_COMMAND").map(|v| format!("{v} -o BatchMode=yes")).unwrap_or_else(|_| "ssh -o BatchMode=yes".into()))
            .output(),
    )
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
    let branch;
    if let Some(b) = set_upstream {
        if b.starts_with('-') || b.contains(char::is_whitespace) || b.is_empty() {
            return Err(format!("invalid branch name {b:?}"));
        }
        branch = b;
        args.extend(["-u", "origin", branch.as_str()]);
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
