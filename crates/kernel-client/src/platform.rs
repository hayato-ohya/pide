//! OS-specific helpers: how ipykernel is told about its parent and how it is
//! interrupted.  Unix uses SIGINT and `JPY_PARENT_PID`; Windows uses two
//! inheritable Win32 handles passed as `JPY_INTERRUPT_EVENT` / `JPY_PARENT_PID`
//! (ipykernel's ParentPollerWindows waits on both).  Note that on Windows the
//! event only trips Python's eval loop (`_thread.interrupt_main`), so a cell
//! blocked in a C call such as `time.sleep()` stops when that call returns;
//! this matches Jupyter's behaviour there.

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
            extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            unsafe { kill(pid as i32, 2) == 0 }
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
