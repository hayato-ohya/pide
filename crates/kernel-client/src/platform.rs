//! OS-specific helpers: how ipykernel is told about its parent and how it is
//! interrupted.  Unix uses SIGINT and `JPY_PARENT_PID`; Windows uses two
//! inheritable Win32 handles passed as `JPY_INTERRUPT_EVENT` / `JPY_PARENT_PID`
//! (ipykernel's ParentPollerWindows waits on both).  Note that on Windows the
//! event only trips Python's eval loop (`_thread.interrupt_main`), so a cell
//! blocked in a C call such as `time.sleep()` stops when that call returns;
//! this matches Jupyter's behaviour there.
//!
//! On Unix a local kernel runs in its own process group so that an interrupt
//! (and a forced kill) also reaches processes started by user code, e.g.
//! `subprocess.run(["sleep", "30"])`.

use tokio::process::Command;

/// Hide the console window of children on Windows (no-op elsewhere).
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

/// Put a local kernel in a new process group of its own (Unix; no-op elsewhere).
/// The group id is the kernel's pid, which `interrupt` / `kill_group` signal.
/// It also keeps a terminal's Ctrl+C (e.g. under `tauri dev`) away from the kernel.
pub fn own_process_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

/// SIGKILL every process left in the kernel's process group (Unix; no-op
/// elsewhere).  Safe after the leader has been reaped: a group id is not
/// reused while any member is alive, and an empty group just yields ESRCH.
pub fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        kill(-(pid as i32), 9);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Whether a process with this pid exists (Unix); None where that cannot be told cheaply.
pub fn process_alive(pid: u32) -> Option<bool> {
    #[cfg(unix)]
    {
        // Signal 0 only checks: EPERM means it exists but belongs to someone else.
        let ok = unsafe { kill(pid as i32, 0) } == 0;
        Some(ok || std::io::Error::last_os_error().raw_os_error() == Some(1))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

/// Per-kernel handles needed to interrupt it / let it watch us.
#[derive(Debug, Default)]
pub struct KernelHandles {
    #[cfg(windows)]
    pub interrupt_event: isize,
    #[cfg(windows)]
    pub parent_handle: isize,
}

impl KernelHandles {
    /// Create the handles and add the matching environment variables to `cmd`.
    pub fn prepare(cmd: &mut Command) -> Self {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE};
            use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
            use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentProcess};
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
            // Auto-reset event: SetEvent wakes the kernel's poller once.
            let ev: HANDLE = unsafe { CreateEventW(&sa, 0, 0, std::ptr::null()) };
            let mut parent: HANDLE = std::ptr::null_mut();
            unsafe {
                DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &mut parent, 0, 1, DUPLICATE_SAME_ACCESS);
            }
            let h = KernelHandles { interrupt_event: ev as isize, parent_handle: parent as isize };
            if h.interrupt_event != 0 {
                cmd.env("JPY_INTERRUPT_EVENT", h.interrupt_event.to_string());
                // jupyter_client also sets this legacy name.
                cmd.env("IPY_INTERRUPT_EVENT", h.interrupt_event.to_string());
            }
            if h.parent_handle != 0 {
                cmd.env("JPY_PARENT_PID", h.parent_handle.to_string());
            }
            h
        }
        #[cfg(not(windows))]
        {
            cmd.env("JPY_PARENT_PID", std::process::id().to_string());
            KernelHandles::default()
        }
    }

    /// Interrupt a local kernel process.  Returns false when the platform
    /// mechanism is unavailable (caller falls back to `interrupt_request`).
    pub fn interrupt(&self, pid: u32) -> bool {
        #[cfg(unix)]
        {
            // SIGINT the whole group (kernel + children of user code); fall back to the
            // process alone if it is not a group leader.
            unsafe { kill(-(pid as i32), 2) == 0 || kill(pid as i32, 2) == 0 }
        }
        #[cfg(windows)]
        {
            let _ = pid;
            if self.interrupt_event == 0 {
                return false;
            }
            use windows_sys::Win32::Foundation::GetLastError;
            use windows_sys::Win32::System::Threading::SetEvent;
            let ok = unsafe { SetEvent(self.interrupt_event as _) } != 0;
            let err = unsafe { GetLastError() };
            tracing::debug!("SetEvent(interrupt event {}) -> {ok} (GetLastError {err})", self.interrupt_event);
            ok
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = pid;
            false
        }
    }
}

impl Drop for KernelHandles {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            if self.interrupt_event != 0 { CloseHandle(self.interrupt_event as _); }
            if self.parent_handle != 0 { CloseHandle(self.parent_handle as _); }
        }
    }
}
