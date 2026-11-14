//! Carries out the lifecycle reducer's effects for the iOS app.
//!
//! One thread owns the state and applies events in arrival order. The engine thread, the
//! health probes, the tick thread and the window callbacks only send events.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use url::Url;

use super::python::Interpreter;
use crate::engine::probe_health;
use crate::lifecycle::{failure_page, parse_boot_line, start, step, Effect, Event, State};

const TICK: Duration = Duration::from_millis(500);

/// The port the WebView may navigate to; the navigation handler reads it.
pub type EnginePort = Arc<Mutex<Option<u16>>>;

pub struct Driver {
    pub app: AppHandle,
    pub events: Sender<Event>,
    pub boot_token: String,
    pub engine_port: EnginePort,
}

impl Driver {
    /// Start the lifecycle on its own thread, plus the tick thread.
    pub fn spawn(self, inbox: Receiver<Event>) {
        let ticks = self.events.clone();
        thread::spawn(move || {
            while ticks.send(Event::Tick).is_ok() {
                thread::sleep(TICK);
            }
        });
        thread::spawn(move || self.run(inbox));
    }

    fn run(self, inbox: Receiver<Event>) {
        let (mut state, effects) = start(Instant::now());
        eprintln!("ShareCut lifecycle: {}", state.label());
        self.apply(&state, effects);
        for event in inbox {
            let (next, effects) = step(&state, &event, Instant::now());
            if next.label() != state.label() {
                eprintln!("ShareCut lifecycle: {} -> {}", state.label(), next.label());
            }
            state = next;
            self.apply(&state, effects);
        }
    }

    fn apply(&self, state: &State, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::StartEngine => self.start_engine(),
                Effect::ProbeHealth { port, generation } => self.probe(port, generation),
                Effect::Navigate { port, url } => {
                    if let Ok(mut allowed) = self.engine_port.lock() {
                        *allowed = Some(port);
                    }
                    if !self.navigate(Url::parse(url.expose()).ok()) {
                        let _ = self.events.send(Event::NavigationFailed);
                    }
                }
                Effect::ShowFailure { sentence } => {
                    let retryable = matches!(state, State::Failed { reason } if reason.retryable());
                    self.navigate(Some(failure_page(sentence, retryable)));
                }
            }
        }
    }

    fn start_engine(&self) {
        let events = self.events.clone();
        thread::spawn(move || {
            let line = Interpreter::get().boot_line();
            let event = parse_boot_line(&line);
            if let Event::StartFailed { reason } = &event {
                eprintln!("ShareCut engine did not start: {reason}");
            }
            let _ = events.send(event);
        });
    }

    fn probe(&self, port: u16, generation: u64) {
        let events = self.events.clone();
        let token = self.boot_token.clone();
        thread::spawn(move || {
            let healthy = probe_health(port, Some(&token)).unwrap_or(false);
            let _ = events.send(if healthy {
                Event::Healthy { generation }
            } else {
                Event::Unhealthy { generation }
            });
        });
    }

    /// Whether the WebView was sent to `url`. The error text is never logged: it can carry the URL.
    fn navigate(&self, url: Option<Url>) -> bool {
        let Some(url) = url else {
            eprintln!("ShareCut could not form a navigation url");
            return false;
        };
        let Some(window) = self.app.get_webview_window("main") else {
            eprintln!("ShareCut has no window to navigate");
            return false;
        };
        if window.navigate(url).is_err() {
            eprintln!("ShareCut navigation failed");
            return false;
        }
        true
    }
}
