//! WebView microphone allowlist adapters (Tauri `with_webview`).
//!
//! Origin checks live in [`sharecut::decide_webview_media`]. Tauri 2.11 has no
//! `on_permission_request` (that lands in 2.12 / wry `with_permission_handler`).
//! Linux/AppImage does not install a handler — WebKitGTK's default prompt applies.

use std::sync::{Arc, Mutex};

use tauri::WebviewWindow;

pub fn install_engine_microphone_handler(
    win: &WebviewWindow,
    engine_port: Arc<Mutex<Option<u16>>>,
) {
    if let Err(err) = win.with_webview(move |webview| {
        #[cfg(windows)]
        install_windows(webview, engine_port.clone());
        #[cfg(target_os = "macos")]
        install_macos(webview, engine_port.clone());
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (webview, engine_port);
            eprintln!(
                "Sharecut Studio: WebView microphone allowlist is not installed on this OS \
                 (Linux uses WebKitGTK defaults; record-in-browser is the supported guest path)."
            );
        }
    }) {
        eprintln!("Sharecut Studio: failed to install WebView microphone handler: {err}");
    }
}

#[cfg(windows)]
fn install_windows(webview: tauri::webview::PlatformWebview, engine_port: Arc<Mutex<Option<u16>>>) {
    use webview2_com::PermissionRequestedEventHandler;

    unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(err) => {
                eprintln!("Sharecut Studio: WebView2 CoreWebView2 missing: {err:?}");
                return;
            }
        };
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            decide_windows(args, &engine_port)
        }));
        let mut token = 0_i64;
        if let Err(err) = core.add_PermissionRequested(&handler, &mut token) {
            eprintln!("Sharecut Studio: failed to add WebView2 PermissionRequested: {err:?}");
        }
    }
}

#[cfg(windows)]
fn decide_windows(
    args: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs,
    engine_port: &Arc<Mutex<Option<u16>>>,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;

    match decide_windows_inner(&args, engine_port) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
            Err(err)
        }
    }
}

#[cfg(windows)]
fn decide_windows_inner(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs,
    engine_port: &Arc<Mutex<Option<u16>>>,
) -> windows::core::Result<()> {
    use sharecut::{decide_webview_media, WebviewMediaDecision, WebviewMediaKind};
    use webview2_com::{
        take_pwstr,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
    };
    use windows::core::PWSTR;

    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
    args.PermissionKind(&mut kind)?;
    let mut uri = PWSTR::null();
    args.Uri(&mut uri)?;
    let origin = take_pwstr(uri);
    let mapped = if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
        WebviewMediaKind::Microphone
    } else {
        WebviewMediaKind::Other
    };
    let port = engine_port.lock().ok().and_then(|g| *g);
    let decision = decide_webview_media(mapped, &origin, port);
    let state = match decision {
        WebviewMediaDecision::Allow => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        WebviewMediaDecision::Deny => COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    args.SetState(state)?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos_ui {
    use std::sync::{Arc, Mutex};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
    use objc2_web_kit::{
        WKFrameInfo, WKMediaCaptureType, WKPermissionDecision, WKSecurityOrigin, WKUIDelegate,
        WKWebView,
    };
    use sharecut::{decide_webview_media, WebviewMediaDecision, WebviewMediaKind};

    pub struct Ivars {
        pub original: Option<Retained<ProtocolObject<dyn WKUIDelegate>>>,
        pub engine_port: Arc<Mutex<Option<u16>>>,
    }

    fn original_ptr(
        original: &Option<Retained<ProtocolObject<dyn WKUIDelegate>>>,
    ) -> *mut AnyObject {
        match original {
            Some(d) => Retained::as_ptr(d) as *mut AnyObject,
            None => std::ptr::null_mut(),
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        #[name = "SharecutMediaUIDelegate"]
        pub struct SharecutMediaUIDelegate;

        unsafe impl NSObjectProtocol for SharecutMediaUIDelegate {}

        unsafe impl WKUIDelegate for SharecutMediaUIDelegate {
            #[allow(non_snake_case)]
            #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
            unsafe fn webView_requestMediaCapturePermissionForOrigin_initiatedByFrame_type_decisionHandler(
                &self,
                _web_view: &WKWebView,
                origin: &WKSecurityOrigin,
                _frame: &WKFrameInfo,
                r#type: WKMediaCaptureType,
                decision_handler: &block2::DynBlock<dyn Fn(WKPermissionDecision)>,
            ) {
                let kind = if r#type == WKMediaCaptureType::Microphone {
                    WebviewMediaKind::Microphone
                } else {
                    WebviewMediaKind::Other
                };
                let protocol = origin.protocol().to_string();
                let host = origin.host().to_string();
                let port = origin.port();
                let origin_url = if port > 0 {
                    format!("{protocol}://{host}:{port}")
                } else {
                    format!("{protocol}://{host}")
                };
                let engine_port = self.ivars().engine_port.lock().ok().and_then(|g| *g);
                let decision = decide_webview_media(kind, &origin_url, engine_port);
                let wk = match decision {
                    WebviewMediaDecision::Allow => WKPermissionDecision::Grant,
                    WebviewMediaDecision::Deny => WKPermissionDecision::Deny,
                };
                decision_handler.call((wk,));
            }
        }

        impl SharecutMediaUIDelegate {
            #[unsafe(method(respondsToSelector:))]
            fn responds_to_selector(&self, selector: Sel) -> Bool {
                if selector
                    == sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:)
                {
                    return Bool::YES;
                }
                let original = original_ptr(&self.ivars().original);
                if !original.is_null() {
                    let forwarded: Bool =
                        unsafe { msg_send![original, respondsToSelector: selector] };
                    if forwarded.as_bool() {
                        return Bool::YES;
                    }
                }
                unsafe { msg_send![super(self), respondsToSelector: selector] }
            }

            #[unsafe(method(methodSignatureForSelector:))]
            fn method_signature_for_selector(&self, selector: Sel) -> *mut AnyObject {
                let original = original_ptr(&self.ivars().original);
                if !original.is_null() {
                    let sig: *mut AnyObject =
                        unsafe { msg_send![original, methodSignatureForSelector: selector] };
                    if !sig.is_null() {
                        return sig;
                    }
                }
                unsafe { msg_send![super(self), methodSignatureForSelector: selector] }
            }

            #[unsafe(method(forwardingTargetForSelector:))]
            fn forwarding_target(&self, _sel: Sel) -> *mut AnyObject {
                original_ptr(&self.ivars().original)
            }
        }
    );

    impl SharecutMediaUIDelegate {
        pub fn new(
            mtm: objc2::MainThreadMarker,
            original: Option<Retained<ProtocolObject<dyn WKUIDelegate>>>,
            engine_port: Arc<Mutex<Option<u16>>>,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars {
                original,
                engine_port,
            });
            unsafe { msg_send![super(this), init] }
        }
    }
}

#[cfg(target_os = "macos")]
fn install_macos(webview: tauri::webview::PlatformWebview, engine_port: Arc<Mutex<Option<u16>>>) {
    use objc2::runtime::ProtocolObject;
    use objc2::MainThreadMarker;
    use objc2_web_kit::WKWebView;

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("Sharecut Studio: microphone handler needs the main thread");
        return;
    };
    unsafe {
        let view: &WKWebView = &*webview.inner().cast();
        let original = view.UIDelegate();
        let delegate = macos_ui::SharecutMediaUIDelegate::new(mtm, original, engine_port);
        view.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        std::mem::forget(delegate);
    }
}
