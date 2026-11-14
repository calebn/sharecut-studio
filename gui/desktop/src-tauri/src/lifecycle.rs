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

/// The start error when the WebView cannot be sent to the engine; it holds no URL.
const NAVIGATION_FAILED: &str = "the engine's page could not be opened";
const EXCHANGE_PATH: &str = "/api/session/exchange";
const EXCHANGE_PARAM: &str = "code";
/// The splash page the packaged WebView starts on; it reads the failure from its query.
const SPLASH_URL: &str = "tauri://localhost/";
/// A navigation to this scheme is the splash's Try again link; the host handles it, nothing loads.
pub const RETRY_SCHEME: &str = "sharecut-retry";

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

    pub fn sentence(&self) -> &'static str {
        match self {
            Self::StartTimedOut => "ShareCut took too long to start.",
            Self::StartError(_) => "ShareCut couldn't start on this device.",
            Self::StoppedAnswering => "ShareCut stopped responding. Reopen the app.",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum State {
    Starting {
        deadline: Instant,
    },
    /// `probes` counts the health probes asked for so far; each carries its number.
    Serving {
        port: u16,
        probes: u64,
    },
    /// A result counts only when its generation is at least `first`, the number of the probe that
    /// opened this recheck, so an answer to an earlier probe cannot satisfy it.
    Rechecking {
        port: u16,
        deadline: Instant,
        first: u64,
        probes: u64,
    },
    Failed {
        reason: FailReason,
    },
}

impl State {
    /// A label for the log: it never includes the port, a deadline or a failure's detail.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Starting { .. } => "Starting",
            Self::Serving { .. } => "Serving",
            Self::Rechecking { .. } => "Rechecking",
            Self::Failed { .. } => "Failed",
        }
    }
}

/// The state the host is in when it starts the engine thread, and the effect that starts it.
pub fn start(now: Instant) -> (State, Vec<Effect>) {
    (
        State::Starting {
            deadline: now + START_DEADLINE,
        },
        vec![Effect::StartEngine],
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Event {
    /// The engine is listening and handed back its single-use exchange code.
    Bound {
        port: u16,
        code: Secret,
    },
    /// A health probe succeeded; `generation` is the number its `ProbeHealth` carried.
    Healthy {
        generation: u64,
    },
    Unhealthy {
        generation: u64,
    },
    NavigationFailed,
    StartFailed {
        reason: String,
    },
    /// Time passed; the caller sends one at a steady interval.
    Tick,
    Resumed,
    RetryRequested,
}

#[derive(Clone, Eq, PartialEq)]
pub enum Effect {
    ProbeHealth {
        port: u16,
        generation: u64,
    },
    /// Send the WebView to the engine; the host allows navigation to `port` from here on.
    Navigate {
        port: u16,
        url: Secret,
    },
    ShowFailure {
        sentence: &'static str,
    },
    StartEngine,
}

impl fmt::Debug for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProbeHealth { port, generation } => {
                write!(
                    f,
                    "ProbeHealth {{ port: {port}, generation: {generation} }}"
                )
            }
            Self::Navigate { port, .. } => {
                write!(f, "Navigate {{ port: {port}, url: Secret(..) }}")
            }
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

/// What the engine thread said, as the event it stands for.
///
/// The boot line is `ok <port> <code>` or `error <one line>` (`podcast_mcp.gui.embedded_boot`).
pub fn parse_boot_line(line: &str) -> Event {
    let start_failed = |reason: &str| Event::StartFailed {
        reason: reason.to_string(),
    };
    let mut parts = line.trim().splitn(3, ' ');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("ok"), Some(port), Some(code)) => match port.parse::<u16>() {
            Ok(port) if port != 0 && !code.is_empty() => Event::Bound {
                port,
                code: Secret::new(code),
            },
            _ => start_failed("the engine answered with an unusable port"),
        },
        (Some("ok"), _, None) => start_failed("the engine returned no session code"),
        (Some("error"), Some(first), rest) => {
            let detail = [Some(first), rest]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            start_failed(&detail.join(" "))
        }
        _ => start_failed("the engine answered with something unreadable"),
    }
}

/// The splash with the failure sentence in its query, and its Try again link when retryable.
pub fn failure_page(sentence: &str, retryable: bool) -> Url {
    let mut url = Url::parse(SPLASH_URL).expect("splash url is valid");
    url.query_pairs_mut()
        .append_pair("failure", sentence)
        .append_pair("retry", if retryable { "1" } else { "0" });
    url
}

fn failed(reason: FailReason) -> (State, Vec<Effect>) {
    let sentence = reason.sentence();
    (
        State::Failed { reason },
        vec![Effect::ShowFailure { sentence }],
    )
}

fn serve(port: u16, code: &Secret) -> (State, Vec<Effect>) {
    (
        State::Serving { port, probes: 0 },
        vec![Effect::Navigate {
            port,
            url: exchange_url(port, code),
        }],
    )
}

fn probe(port: u16, generation: u64) -> Effect {
    Effect::ProbeHealth { port, generation }
}

/// One row of the lifecycle table: the next state and what the host must do.
pub fn step(state: &State, event: &Event, now: Instant) -> (State, Vec<Effect>) {
    match (state, event) {
        (State::Starting { .. }, Event::Bound { port, code }) => serve(*port, code),
        // The engine can finish starting after the deadline passed; serving is better than the
        // failure page, and only a failure that offers Try again leaves the engine possibly alive.
        (State::Failed { reason }, Event::Bound { port, code }) if reason.retryable() => {
            serve(*port, code)
        }
        (State::Starting { .. }, Event::StartFailed { reason }) => {
            failed(FailReason::StartError(reason.clone()))
        }
        (State::Starting { deadline }, Event::Tick) if now >= *deadline => {
            failed(FailReason::StartTimedOut)
        }

        (State::Serving { .. }, Event::NavigationFailed) => {
            failed(FailReason::StartError(NAVIGATION_FAILED.to_string()))
        }
        (State::Serving { port, probes }, Event::Resumed) => {
            let generation = probes + 1;
            (
                State::Rechecking {
                    port: *port,
                    deadline: now + RECHECK_DEADLINE,
                    first: generation,
                    probes: generation,
                },
                vec![probe(*port, generation)],
            )
        }

        (
            State::Rechecking {
                port,
                first,
                probes,
                ..
            },
            Event::Healthy { generation },
        ) if generation >= first => (
            State::Serving {
                port: *port,
                probes: *probes,
            },
            vec![],
        ),
        (
            State::Rechecking {
                port,
                deadline,
                first,
                probes,
            },
            Event::Tick | Event::Resumed,
        ) => {
            if matches!(event, Event::Tick) && now >= *deadline {
                failed(FailReason::StoppedAnswering)
            } else {
                let generation = probes + 1;
                (
                    State::Rechecking {
                        port: *port,
                        deadline: *deadline,
                        first: *first,
                        probes: generation,
                    },
                    vec![probe(*port, generation)],
                )
            }
        }

        (State::Failed { reason }, Event::RetryRequested) if reason.retryable() => start(now),

        // Everything else is a stale or irrelevant event: a probe result with no probe
        // pending or from before this recheck, a second Bound after the engine served, a Retry
        // on a state that cannot retry. The state stays and nothing is done.
        _ => (state.clone(), vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 51234;
    const URL: &str = "http://127.0.0.1:51234/api/session/exchange?code=abc-_123";

    fn starting(now: Instant) -> State {
        start(now).0
    }

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
            port: PORT,
            url: Secret::new(URL),
        }
    }

    fn serving() -> State {
        State::Serving {
            port: PORT,
            probes: 0,
        }
    }

    fn rechecking(now: Instant) -> State {
        State::Rechecking {
            port: PORT,
            deadline: now + RECHECK_DEADLINE,
            first: 1,
            probes: 1,
        }
    }

    fn probe_effect(generation: u64) -> Effect {
        Effect::ProbeHealth {
            port: PORT,
            generation,
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
            Event::Healthy { generation: 1 },
            Event::Unhealthy { generation: 1 },
            Event::StartFailed {
                reason: "boom".to_string(),
            },
            Event::Tick,
            Event::Resumed,
            Event::RetryRequested,
            Event::NavigationFailed,
        ]
    }

    fn states(now: Instant) -> Vec<State> {
        vec![
            State::Starting {
                deadline: now + START_DEADLINE,
            },
            serving(),
            rechecking(now),
            failed_with(start_error()),
            failed_with(FailReason::StoppedAnswering),
        ]
    }

    #[test]
    fn starting_bound_serves_and_navigates_to_the_exchange_url() {
        let now = t0();
        let (state, effects) = step(&starting(now), &bound(), now);
        assert_eq!(state, serving());
        assert_eq!(effects, vec![navigate()]);
    }

    #[test]
    fn starting_start_failed_fails_retryable_with_the_sentence() {
        let now = t0();
        let event = Event::StartFailed {
            reason: "ModuleNotFoundError: yaml".to_string(),
        };
        let (state, effects) = step(&starting(now), &event, now);
        assert_eq!(state, failed_with(start_error()));
        assert_eq!(
            effects,
            vec![show("ShareCut couldn't start on this device.")]
        );
    }

    #[test]
    fn starting_tick_before_the_deadline_waits() {
        let now = t0();
        let starting = starting(now);
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
        let (state, effects) = step(&starting(now), &Event::Tick, now + START_DEADLINE);
        assert_eq!(state, failed_with(FailReason::StartTimedOut));
        assert_eq!(effects, vec![show("ShareCut took too long to start.")]);
    }

    #[test]
    fn a_late_tick_still_uses_the_deadline_fixed_on_entry() {
        let now = t0();
        let starting = starting(now);
        let far = now + START_DEADLINE * 10;
        assert_eq!(
            step(&starting, &Event::Tick, far).0,
            failed_with(FailReason::StartTimedOut)
        );
    }

    #[test]
    fn serving_resumed_rechecks_the_same_port_with_a_fresh_deadline_and_the_next_probe_number() {
        let now = t0();
        let (state, effects) = step(&serving(), &Event::Resumed, now);
        assert_eq!(state, rechecking(now));
        assert_eq!(effects, vec![probe_effect(1)]);
    }

    #[test]
    fn rechecking_healthy_goes_back_to_serving_quietly() {
        let now = t0();
        let (state, effects) = step(&rechecking(now), &Event::Healthy { generation: 1 }, now);
        assert_eq!(
            state,
            State::Serving {
                port: PORT,
                probes: 1
            }
        );
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn rechecking_tick_before_the_deadline_probes_again_without_moving_the_deadline() {
        let now = t0();
        let (state, effects) = step(&rechecking(now), &Event::Tick, now + Duration::from_secs(5));
        assert_eq!(
            state,
            State::Rechecking {
                port: PORT,
                deadline: now + RECHECK_DEADLINE,
                first: 1,
                probes: 2
            }
        );
        assert_eq!(effects, vec![probe_effect(2)]);
    }

    #[test]
    fn rechecking_resumed_probes_again_and_keeps_the_deadline() {
        let now = t0();
        let (state, effects) = step(
            &rechecking(now),
            &Event::Resumed,
            now + RECHECK_DEADLINE * 2,
        );
        assert_eq!(
            state,
            State::Rechecking {
                port: PORT,
                deadline: now + RECHECK_DEADLINE,
                first: 1,
                probes: 2
            }
        );
        assert_eq!(effects, vec![probe_effect(2)]);
    }

    #[test]
    fn an_answer_to_a_later_probe_of_the_same_recheck_counts() {
        let now = t0();
        let (second, _) = step(&rechecking(now), &Event::Tick, now);
        let (state, effects) = step(&second, &Event::Healthy { generation: 2 }, now);
        assert_eq!(
            state,
            State::Serving {
                port: PORT,
                probes: 2
            }
        );
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn a_probe_answer_from_an_earlier_recheck_cannot_satisfy_a_later_one() {
        let now = t0();
        let (first, _) = step(&serving(), &Event::Resumed, now);
        let (served_again, _) = step(&first, &Event::Healthy { generation: 1 }, now);
        let (second, effects) = step(&served_again, &Event::Resumed, now);
        assert_eq!(
            second,
            State::Rechecking {
                port: PORT,
                deadline: now + RECHECK_DEADLINE,
                first: 2,
                probes: 2
            }
        );
        assert_eq!(effects, vec![probe_effect(2)]);
        let (state, effects) = step(&second, &Event::Healthy { generation: 1 }, now);
        assert_eq!(state, second);
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn rechecking_tick_at_the_deadline_fails_without_a_retry() {
        let now = t0();
        let (state, effects) = step(&rechecking(now), &Event::Tick, now + RECHECK_DEADLINE);
        assert_eq!(state, failed_with(FailReason::StoppedAnswering));
        assert_eq!(
            effects,
            vec![show("ShareCut stopped responding. Reopen the app.")]
        );
    }

    #[test]
    fn unhealthy_while_rechecking_waits_for_the_next_tick_instead_of_spinning() {
        let now = t0();
        let (state, effects) = step(&rechecking(now), &Event::Unhealthy { generation: 1 }, now);
        assert_eq!(state, rechecking(now));
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn retry_from_a_retryable_failure_starts_the_engine_with_a_new_deadline() {
        let now = t0();
        for reason in [FailReason::StartTimedOut, start_error()] {
            let (state, effects) = step(&failed_with(reason), &Event::RetryRequested, now);
            assert_eq!(state, starting(now));
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
    fn a_late_bound_in_a_retryable_failure_serves_and_navigates() {
        let now = t0();
        for reason in [FailReason::StartTimedOut, start_error()] {
            let (state, effects) = step(&failed_with(reason), &bound(), now);
            assert_eq!(state, serving());
            assert_eq!(effects, vec![navigate()]);
        }
    }

    #[test]
    fn a_bound_after_a_failure_that_cannot_retry_is_ignored() {
        let now = t0();
        let terminal = failed_with(FailReason::StoppedAnswering);
        let (state, effects) = step(&terminal, &bound(), now);
        assert_eq!(state, terminal);
        assert_eq!(effects, vec![]);
    }

    #[test]
    fn a_navigation_that_fails_after_bound_fails_the_start_with_its_sentence() {
        let now = t0();
        let (state, effects) = step(&serving(), &Event::NavigationFailed, now);
        assert_eq!(
            state,
            failed_with(FailReason::StartError(
                "the engine's page could not be opened".to_string()
            ))
        );
        assert_eq!(
            effects,
            vec![show("ShareCut couldn't start on this device.")]
        );
    }

    #[test]
    fn the_table_is_total_and_acts_on_exactly_these_pairs() {
        let now = t0();
        // Rows: Starting, Serving, Rechecking, Failed (retryable), Failed (terminal).
        // Columns follow `all_events`: Bound, Healthy, Unhealthy, StartFailed, Tick, Resumed,
        // Retry, NavigationFailed. A Tick at `now` is before every deadline.
        let acts = [
            [true, false, false, true, false, false, false, false],
            [false, false, false, false, false, true, false, true],
            [false, true, false, false, true, true, false, false],
            [true, false, false, false, false, false, true, false],
            [false, false, false, false, false, false, false, false],
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
        assert_eq!(effect, "Navigate { port: 51234, url: Secret(..) }");
    }

    #[test]
    fn the_host_starts_in_starting_and_asks_for_the_engine() {
        let now = t0();
        assert_eq!(
            start(now),
            (
                State::Starting {
                    deadline: now + START_DEADLINE
                },
                vec![Effect::StartEngine]
            )
        );
    }

    #[test]
    fn an_ok_boot_line_binds_the_port_and_code() {
        assert_eq!(parse_boot_line("ok 51234 abc-_123\n"), bound());
    }

    #[test]
    fn a_boot_line_without_a_code_fails_the_start() {
        assert_eq!(
            parse_boot_line("ok 51234"),
            Event::StartFailed {
                reason: "the engine returned no session code".to_string()
            }
        );
    }

    #[test]
    fn an_error_boot_line_carries_its_one_line_reason() {
        assert_eq!(
            parse_boot_line("error ModuleNotFoundError: No module named 'yaml'"),
            Event::StartFailed {
                reason: "ModuleNotFoundError: No module named 'yaml'".to_string()
            }
        );
    }

    #[test]
    fn an_unreadable_boot_line_fails_the_start() {
        for line in [
            "",
            "ok",
            "ok zero code",
            "ok 0 code",
            "ok 70000 code",
            "hello 1 2",
        ] {
            assert!(
                matches!(parse_boot_line(line), Event::StartFailed { .. }),
                "{line:?}"
            );
        }
    }

    #[test]
    fn the_failure_page_carries_the_sentence_and_whether_to_offer_retry() {
        assert_eq!(
            failure_page("ShareCut couldn't start on this device.", true).as_str(),
            "tauri://localhost/?failure=ShareCut+couldn%27t+start+on+this+device.&retry=1"
        );
        assert_eq!(
            failure_page("ShareCut stopped responding. Reopen the app.", false).as_str(),
            "tauri://localhost/?failure=ShareCut+stopped+responding.+Reopen+the+app.&retry=0"
        );
    }

    #[test]
    fn state_labels_name_the_state_and_nothing_else() {
        let now = t0();
        let labels: Vec<_> = states(now).iter().map(State::label).collect();
        assert_eq!(
            labels,
            ["Starting", "Serving", "Rechecking", "Failed", "Failed"]
        );
    }
}
