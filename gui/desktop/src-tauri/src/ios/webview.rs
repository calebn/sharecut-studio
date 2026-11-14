//! Native WebView settings the Studio's layout depends on.

use objc2::msg_send;
use objc2::runtime::AnyObject;

/// `UIScrollViewContentInsetAdjustmentNever`.
const CONTENT_INSET_NEVER: isize = 2;

/// Lay the page out over the whole screen.
///
/// WKWebView's default (`automatic`) takes the status bar and home indicator out of the layout
/// viewport, so `innerHeight` is the screen minus both insets while the page still paints from
/// the top edge, and the bottom band stays empty. The page already pads itself with
/// `env(safe-area-inset-*)` under `viewport-fit=cover`, so the native inset is the second one.
pub fn lay_out_over_the_whole_screen(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|webview| {
        let web_view = webview.inner().cast::<AnyObject>();
        // SAFETY: `inner` is the live WKWebView and this closure runs on the main thread.
        unsafe {
            let scroll_view: *mut AnyObject = msg_send![web_view, scrollView];
            let () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: CONTENT_INSET_NEVER];
        }
    });
    if let Err(error) = result {
        eprintln!("ShareCut could not set the WebView layout: {error}");
    }
}
