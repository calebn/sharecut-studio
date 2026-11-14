//! The embedded CPython: linked from Python.xcframework, started once, never finalized.
//!
//! The interpreter starts on the engine thread, releases the GIL right after, and every later
//! call takes it with `PyGILState_Ensure`.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::OnceLock;

type PyObject = c_void;

extern "C" {
    fn Py_InitializeEx(initsigs: c_int);
    fn PyEval_SaveThread() -> *mut c_void;
    fn PyGILState_Ensure() -> c_int;
    fn PyGILState_Release(state: c_int);
    fn PyImport_ImportModule(name: *const c_char) -> *mut PyObject;
    fn PyObject_CallMethod(
        obj: *mut PyObject,
        name: *const c_char,
        format: *const c_char,
        ...
    ) -> *mut PyObject;
    fn PyUnicode_AsUTF8(obj: *mut PyObject) -> *const c_char;
    fn Py_DecRef(obj: *mut PyObject);
    fn PyErr_Print();
}

const BOOT_MODULE: &CStr = c"podcast_mcp.gui.embedded_boot";
const BOOT_FUNCTION: &CStr = c"boot_line";
const UNLOADABLE: &str = "error the engine could not be loaded";

/// Proof that the interpreter is initialized.
pub struct Interpreter(());

static INTERPRETER: OnceLock<Interpreter> = OnceLock::new();

impl Interpreter {
    /// Start the interpreter on first use. The caller sets PYTHONHOME and PYTHONPATH before any thread exists.
    pub fn get() -> &'static Interpreter {
        INTERPRETER.get_or_init(|| {
            // SAFETY: called once (OnceLock) with the environment already set; the thread state
            // PyEval_SaveThread returns is dropped on purpose, so no thread owns the GIL afterwards.
            unsafe {
                Py_InitializeEx(0);
                PyEval_SaveThread();
            }
            Interpreter(())
        })
    }

    /// Call `podcast_mcp.gui.embedded_boot.boot_line()` and return its line.
    pub fn boot_line(&self) -> String {
        // SAFETY: the GIL is held between Ensure and Release; each owned reference is released once.
        unsafe {
            let gil = PyGILState_Ensure();
            let line = call_boot_line();
            PyGILState_Release(gil);
            line
        }
    }
}

/// # Safety
/// The caller holds the GIL.
unsafe fn call_boot_line() -> String {
    let module = PyImport_ImportModule(BOOT_MODULE.as_ptr());
    if module.is_null() {
        PyErr_Print();
        return UNLOADABLE.to_string();
    }
    let result = PyObject_CallMethod(module, BOOT_FUNCTION.as_ptr(), std::ptr::null());
    Py_DecRef(module);
    if result.is_null() {
        PyErr_Print();
        return UNLOADABLE.to_string();
    }
    let text = PyUnicode_AsUTF8(result);
    let line = if text.is_null() {
        UNLOADABLE.to_string()
    } else {
        CStr::from_ptr(text).to_string_lossy().into_owned()
    };
    Py_DecRef(result);
    line
}
