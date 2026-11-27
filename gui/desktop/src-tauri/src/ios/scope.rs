//! Security-scoped access to a file another app (Files, iCloud Drive) handed over in place.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};

/// Run `work` with the file at `path` readable. The grant is released afterwards, whatever `work` returns.
pub fn with_security_scope<T>(path: &Path, work: impl FnOnce() -> T) -> T {
    let Ok(text) = CString::new(path.as_os_str().as_bytes()) else {
        return work();
    };
    autoreleasepool(|_| {
        // SAFETY: the receivers are Foundation classes and the NSURL this builds, each message
        // matches its Foundation signature, and the C string outlives the call that copies it.
        unsafe {
            let string: *mut AnyObject =
                msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()];
            let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: string];
            if url.is_null() {
                return work();
            }
            let granted: Bool = msg_send![url, startAccessingSecurityScopedResource];
            let result = work();
            if granted.as_bool() {
                let () = msg_send![url, stopAccessingSecurityScopedResource];
            }
            result
        }
    })
}
