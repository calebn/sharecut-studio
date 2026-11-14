//! The embedded engine's lifecycle as a pure reducer (the iOS host).
//!
//! The host feeds `Event`s in and carries out the `Effect`s that come back; nothing here
//! touches a clock, a socket, a thread or a WebView, so the whole table runs under
//! `cargo test --lib --no-default-features` on any machine.
//!
//! The engine serves once per process (`podcast_mcp.gui.embedded`). A served engine is never
//! restarted: if it does not answer after the app returns to the foreground the person reopens
//! the app. Only an engine that never served can be retried.
//!
//! Deadlines are `Instant`s, fixed when a state is entered and compared against the `now` the
//! caller passes to every `step`, so a slow or repeated tick cannot stretch them.

use std::fmt;
use std::time::{Duration, Instant};

use url::Url;

/// Cold start measured on a loaded simulator took about 40 seconds; the deadline leaves room
/// for a slower phone. See `docs/desktop-packaging.md` § iOS.
pub const START_DEADLINE: Duration = Duration::from_secs(120);
/// The prototype's listener answered again about 5 seconds after the app came back.
pub const RECHECK_DEADLINE: Duration = Duration::from_secs(20);

const EXCHANGE_PATH: &str = "/api/session/exchange";
const EXCHANGE_PARAM: &str = "code";

/// A value that must never reach a log: `Debug` and `Display` hide it.
#[derive(Clone, Eq, PartialEq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// Why the engine is not serving.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FailReason {
    /// The engine did not report a port before the start deadline.
    StartTimedOut,
    /// The engine reported an error while starting; the detail lives in the engine log.
    StartError(String),
    /// The engine served, then stopped answering after the app came back.
    StoppedAnswering,
}

impl FailReason {
    /// Only an engine that never served can be started again.
    pub fn retryable(&self) -> bool {
        match self {
            Self::StartTimedOut | Self::StartError(_) => true,
            Self::StoppedAnswering => false,
        }
    }

    /// The one sentence the splash shows.
    pub fn sentence(&self) -> &'static str {
        match self {
            Self::StartTimedOut => "ShareCut is taking too long to start. Try again.",
            Self::StartError(_) => "ShareCut couldn't start on this device. Try again.",
            Self::StoppedAnswering => "ShareCut stopped responding. Reopen the app.",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum State {
    Starting { deadline: Instant },
    Serving { port: u16 },
    Rechecking { port: u16, deadline: Instant },
    Failed { reason: FailReason },
}

impl State {
    /// The state the host is in before it starts the engine thread.
    pub fn starting(now: Instant) -> Self {
        Self::Starting {
            deadline: now + START_DEADLINE,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Event {
    /// The engine is listening and handed back its single-use exchange code.
    Bound { port: u16, code: Secret },
    /// The last health probe succeeded.
    Healthy,
    /// The last health probe failed.
    Unhealthy,
    /// The engine could not start.
    StartFailed { reason: String },
    /// Time passed; the caller sends one at a steady interval.
    Tick,
    /// The app returned to the foreground.
    Resumed,
    /// The person pressed Try again.
    RetryRequested,
}

#[derive(Clone, Eq, PartialEq)]
pub enum Effect {
    ProbeHealth { port: u16 },
    Navigate { url: Secret },
    ShowFailure { sentence: &'static str },
    StartEngine,
}

impl fmt::Debug for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProbeHealth { port } => write!(f, "ProbeHealth {{ port: {port} }}"),
            Self::Navigate { .. } => f.write_str("Navigate { url: Secret(..) }"),
            Self::ShowFailure { sentence } => write!(f, "ShowFailure {{ sentence: {sentence:?} }}"),
            Self::StartEngine => f.write_str("StartEngine"),
        }
    }
}

/// The first navigation: the engine origin, which trades the code for the owner's session.
pub fn exchange_url(port: u16, code: &Secret) -> Secret {
    let mut url = Url::parse(&format!("http://127.0.0.1:{port}{EXCHANGE_PATH}"))
        .expect("loopback exchange url is valid");
    url.query_pairs_mut()
        .append_pair(EXCHANGE_PARAM, code.expose());
    Secret::new(url)
}

fn failed(reason: FailReason) -> (State, Vec<Effect>) {
    let sentence = reason.sentence();
    (
        State::Failed { reason },
        vec![Effect::ShowFailure { sentence }],
    )
}

/// One row of the lifecycle table: the next state and what the host must do.
pub fn step(state: &State, event: &Event, now: Instant) -> (State, Vec<Effect>) {
    match (state, event) {
        (State::Starting { .. }, Event::Bound { port, code }) => (
            State::Serving { port: *port },
            vec![Effect::Navigate {
                url: exchange_url(*port, code),
            }],
        ),
        (State::Starting { .. }, Event::StartFailed { reason }) => {
            failed(FailReason::StartError(reason.clone()))
        }
        (State::Starting { deadline }, Event::Tick) if now >= *deadline => {
            failed(FailReason::StartTimedOut)
        }

        (State::Serving { port }, Event::Resumed) => (
            State::Rechecking {
                port: *port,
                deadline: now + RECHECK_DEADLINE,
            },
            vec![Effect::ProbeHealth { port: *port }],
        ),

        (State::Rechecking { port, .. }, Event::Healthy) => {
            (State::Serving { port: *port }, vec![])
        }
        (State::Rechecking { port, deadline }, Event::Tick | Event::Resumed) => {
            if matches!(event, Event::Tick) && now >= *deadline {
                failed(FailReason::StoppedAnswering)
            } else {
                (state.clone(), vec![Effect::ProbeHealth { port: *port }])
            }
        }

        (State::Failed { reason }, Event::RetryRequested) if reason.retryable() => {
            (State::starting(now), vec![Effect::StartEngine])
        }

        // Everything else is a stale or irrelevant event: a probe result with no probe
        // pending, a second Bound after the engine served, a Retry on a state that cannot
        // retry. The state stays and nothing is done.
        _ => (state.clone(), vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 51234;
    const URL: &str = "http://127.0.0.1:51234/api/session/exchange?code=abc-_123";

    fn t0() -> Instant {
        Instant::now()
    }

    fn bound() -> Event {
        Event::Bound {
            port: PORT,
            code: Secret::new("abc-_123"),
        }
    }

    fn navigate() -> Effect {
        Effect::Navigate {
            url: Secret::new(URL),
        }
    }

    fn failed_with(reason: FailReason) -> State {
        State::Failed { reason }
    }

    fn show(sentence: &'static str) -> Effect {
        Effect::ShowFailure { sentence }
    }

    fn start_error() -> FailReason {
        FailReason::StartError("ModuleNotFoundError: yaml".to_string())
    }

    fn all_events() -> Vec<Event> {
        vec![
            bound(),
            Event::Healthy,
            Event::Unhealthy,
            Event::StartFailed {
                reason: "boom".to_string(),
            },
            Event::Tick,
            Event::Resumed,
            Event::RetryRequested,
        ]
    }

    fn states(now: Instant) -> Vec<State> {
        vec![
            State::Starting {
                deadline: now + START_DEADLINE,
            },
            State::Serving { port: PORT },
            State::Rechecking {
                port: PORT,
                deadline: now + RECHECK_DEADLINE,
            },
            failed_with(start_error()),
            failed_with(FailReason::StoppedAnswering),
        ]
    }

    #[test]
    fn starting_bound_serves_and_navigates_to_the_exchange_url() {
        let now = t0();
        let (state, effects) = step(&State::starting(now), &bound(), now);
        assert_eq!(state, State::Serving { port: PORT });
        assert_eq!(effects, vec![navigate()]);
    }

    #[test]
    fn starting_start_failed_fails_retryable_with_the_sentence() {
        let now = t0();
        let event = Event::StartFailed {
            reason: "ModuleNotFoundError: yaml".to_string(),
        };
        let (state, effects) = step(&State::starting(now), &event, now);
        assert_eq!(state, failed_with(start_error()));
        assert_eq!(
            effects,
            vec![show("ShareCut couldn't start on this device. Try again.")]
        );
    }

    #[test]
    fn starting_tick_before_the_deadline_waits() {
        let now = t0();
        let starting = State::starting(now);
        let (state, effects) = step(
            &starting,
            &Event::Tick,
            now + START_DEADLINE - Duration::from_secs(1),
        );
        assert_eq!(state, starting);
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn starting_tick_at_the_deadline_fails_retryable() {
        let now = t0();
        let (state, effects) = step(&State::starting(now), &Event::Tick, now + START_DEADLINE);
        assert_eq!(state, failed_with(FailReason::StartTimedOut));
        assert_eq!(
            effects,
            vec![show("ShareCut is taking too long to start. Try again.")]
        );
    }

    #[test]
    fn a_late_tick_still_uses_the_deadline_fixed_on_entry() {
        let now = t0();
        let starting = State::starting(now);
        let far = now + START_DEADLINE * 10;
        assert_eq!(
            step(&starting, &Event::Tick, far).0,
            failed_with(FailReason::StartTimedOut)
        );
    }

    #[test]
    fn serving_resumed_rechecks_the_same_port_with_a_fresh_deadline() {
        let now = t0();
        let (state, effects) = step(&State::Serving { port: PORT }, &Event::Resumed, now);
        assert_eq!(
            state,
            State::Rechecking {
                port: PORT,
                deadline: now + RECHECK_DEADLINE
            }
        );
        assert_eq!(effects, vec![Effect::ProbeHealth { port: PORT }]);
    }

    #[test]
    fn rechecking_healthy_goes_back_to_serving_quietly() {
        let now = t0();
        let rechecking = State::Rechecking {
            port: PORT,
            deadline: now + RECHECK_DEADLINE,
        };
        let (state, effects) = step(&rechecking, &Event::Healthy, now);
        assert_eq!(state, State::Serving { port: PORT });
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn rechecking_tick_before_the_deadline_probes_again_without_moving_the_deadline() {
        let now = t0();
        let rechecking = State::Rechecking {
            port: PORT,
            deadline: now + RECHECK_DEADLINE,
        };
        let (state, effects) = step(&rechecking, &Event::Tick, now + Duration::from_secs(5));
        assert_eq!(state, rechecking);
        assert_eq!(effects, vec![Effect::ProbeHealth { port: PORT }]);
    }

    #[test]
    fn rechecking_resumed_probes_again_and_keeps_the_deadline() {
        let now = t0();
        let rechecking = State::Rechecking {
            port: PORT,
            deadline: now + RECHECK_DEADLINE,
        };
        let (state, effects) = step(&rechecking, &Event::Resumed, now + RECHECK_DEADLINE * 2);
        assert_eq!(state, rechecking);
        assert_eq!(effects, vec![Effect::ProbeHealth { port: PORT }]);
    }

    #[test]
    fn rechecking_tick_at_the_deadline_fails_without_a_retry() {
        let now = t0();
        let rechecking = State::Rechecking {
            port: PORT,
            deadline: now + RECHECK_DEADLINE,
        };
        let (state, effects) = step(&rechecking, &Event::Tick, now + RECHECK_DEADLINE);
        assert_eq!(state, failed_with(FailReason::StoppedAnswering));
        assert_eq!(
            effects,
            vec![show("ShareCut stopped responding. Reopen the app.")]
        );
    }

    #[test]
    fn unhealthy_while_rechecking_waits_for_the_next_tick_instead_of_spinning() {
        let now = t0();
        let rechecking = State::Rechecking {
            port: PORT,
            deadline: now + RECHECK_DEADLINE,
        };
        let (state, effects) = step(&rechecking, &Event::Unhealthy, now);
        assert_eq!(state, rechecking);
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn retry_from_a_retryable_failure_starts_the_engine_with_a_new_deadline() {
        let now = t0();
        for reason in [FailReason::StartTimedOut, start_error()] {
            let (state, effects) = step(&failed_with(reason), &Event::RetryRequested, now);
            assert_eq!(state, State::starting(now));
            assert_eq!(effects, vec![Effect::StartEngine]);
        }
    }

    #[test]
    fn retry_after_the_engine_served_does_nothing() {
        let now = t0();
        let terminal = failed_with(FailReason::StoppedAnswering);
        let (state, effects) = step(&terminal, &Event::RetryRequested, now);
        assert_eq!(state, terminal);
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn the_table_is_total_and_acts_on_exactly_these_pairs() {
        let now = t0();
        // Rows: Starting, Serving, Rechecking, Failed (retryable), Failed (terminal).
        // Columns follow `all_events`: Bound, Healthy, Unhealthy, StartFailed, Tick, Resumed, Retry.
        // A Tick at `now` is before every deadline.
        let acts = [
            [true, false, false, true, false, false, false],
            [false, false, false, false, false, true, false],
            [false, true, false, false, true, true, false],
            [false, false, false, false, false, false, true],
            [false, false, false, false, false, false, false],
        ];
        for (row, state) in states(now).into_iter().enumerate() {
            for (column, event) in all_events().into_iter().enumerate() {
                let (next, effects) = step(&state, &event, now);
                let acted = next != state || !effects.is_empty();
                assert_eq!(
                    acted, acts[row][column],
                    "{state:?} x {event:?} gave {next:?} {effects:?}"
                );
            }
        }
    }

    #[test]
    fn a_second_bound_after_serving_does_not_navigate_again() {
        let now = t0();
        let serving = State::Serving { port: PORT };
        let (state, effects) = step(&serving, &bound(), now);
        assert_eq!(state, serving);
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn the_exchange_url_encodes_an_unexpected_code() {
        let url = exchange_url(8, &Secret::new("a b&c"));
        assert_eq!(
            url.expose(),
            "http://127.0.0.1:8/api/session/exchange?code=a+b%26c"
        );
    }

    #[test]
    fn debug_output_never_shows_the_code_or_the_url() {
        let event = format!("{:?}", bound());
        let effect = format!("{:?}", navigate());
        assert!(!event.contains("abc-_123"), "{event}");
        assert!(!effect.contains("abc-_123"), "{effect}");
        assert_eq!(effect, "Navigate { url: Secret(..) }");
    }

    #[test]
    fn only_a_never_served_engine_is_retryable() {
        assert!(FailReason::StartTimedOut.retryable());
        assert!(start_error().retryable());
        assert!(!FailReason::StoppedAnswering.retryable());
    }
}
