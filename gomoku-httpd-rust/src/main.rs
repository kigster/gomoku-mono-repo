//! gomoku-httpd-rust — Gomoku AI HTTP Server.
//!
//! Rust port of `gomoku-httpd`. Accepts the same CLI arguments and produces
//! identical JSON to the C version. Each `/gomoku/play` request carries the
//! full game state, so requests are independent and run concurrently up to a
//! per-CPU semaphore limit.

// Stylistic lints that fire against the literal port from C; keeping the
// shape of the algorithm matters more than restructuring to satisfy them.
#![allow(
    clippy::too_many_arguments,
    clippy::needless_range_loop,
    clippy::if_same_then_else,
    clippy::manual_clamp,
    clippy::type_complexity
)]

mod ai;
mod board;
mod eval;
mod game;
mod json_api;
mod telemetry;

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::available_parallelism;
use std::time::Instant;

use actix_cors::Cors;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use clap::Parser;
use clap::builder::styling::{AnsiColor, Effects, Styles};
use log::{Level, debug, error, info, warn};
use nu_ansi_term::{Color, Style};
use opentelemetry::Context;
use opentelemetry::KeyValue;
use opentelemetry::trace::{Span, Status, TraceContextExt, Tracer, mark_span_as_active};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

const DAEMON_VERSION: &str = "1.0.1";

// ============================================================================
// CLI
// ============================================================================

fn cli_styles() -> Styles {
    Styles::styled()
        .header(AnsiColor::Cyan.on_default() | Effects::BOLD)
        .usage(AnsiColor::Cyan.on_default() | Effects::BOLD)
        .literal(AnsiColor::Yellow.on_default() | Effects::BOLD)
        .placeholder(AnsiColor::Green.on_default())
}

const AFTER_HELP: &str = "\x1b[1;36mEXAMPLES:\x1b[0m
  \x1b[1;33mgomoku-httpd-rust -b 3000\x1b[0m
      Listen on 0.0.0.0:3000 with default settings.

  \x1b[1;33mgomoku-httpd-rust -b 127.0.0.1:8080 -L DEBUG\x1b[0m
      Bind to localhost only with debug logging.

  \x1b[1;33mgomoku-httpd-rust -b 8787 -a 8788\x1b[0m
      Run with HAProxy agent-check on TCP port 8788.

  \x1b[1;33mgomoku-httpd-rust -b 3000 -r -j 8\x1b[0m
      Enable scoring reports and cap concurrency at 8 in-flight searches.
";

#[derive(Parser, Debug)]
#[command(name = "gomoku-httpd-rust")]
#[command(version = DAEMON_VERSION)]
#[command(
    about = "Gomoku AI HTTP Server (Rust port of gomoku-httpd)",
    long_about = "Gomoku AI HTTP Server (Rust port of gomoku-httpd).\n\nEach POST to /gomoku/play carries the full game state as JSON; responses use \
        the same field layout as the C reference. Requests run concurrently up \
        to the configured worker limit (defaults to the number of CPU cores)."
)]
#[command(styles = cli_styles())]
#[command(after_help = AFTER_HELP)]
struct Cli {
    /// Address to bind: `host:port`, just `port`, or `[::]:port`.
    #[arg(short = 'b', long = "bind", value_name = "ADDR")]
    bind: String,

    /// HAProxy agent-check TCP port (disabled when omitted).
    #[arg(short = 'a', long = "agent-port", value_name = "PORT")]
    agent_port: Option<u16>,

    /// Daemonize flag (accepted for CLI parity with the C binary; no-op here).
    #[arg(short = 'd', long = "daemonize")]
    daemonize: bool,

    /// Log file path. Logs to stderr by default.
    #[arg(short = 'l', long = "log-file", value_name = "FILE")]
    log_file: Option<String>,

    /// Log level: TRACE, DEBUG, INFO, WARN, ERROR.
    #[arg(
        short = 'L',
        long = "log-level",
        default_value = "INFO",
        value_name = "LEVEL"
    )]
    log_level: String,

    /// Include the AI scoring pipeline report inside JSON responses.
    #[arg(short = 'r', long = "report-scoring")]
    report_scoring: bool,

    /// Maximum concurrent /gomoku/play searches (defaults to detected CPU count).
    #[arg(short = 'j', long = "max-concurrency", value_name = "N")]
    max_concurrency: Option<usize>,

    /// Disable ANSI colors in log output.
    #[arg(short = 'C', long = "no-color")]
    no_color: bool,
}

fn parse_bind_address(s: &str) -> Result<(String, u16), String> {
    if let Some(idx) = s.rfind(':') {
        let host = &s[..idx];
        let port: u16 = s[idx + 1..]
            .parse()
            .map_err(|_| format!("Invalid port in '{}'", s))?;
        Ok((host.to_string(), port))
    } else {
        let port: u16 = s.parse().map_err(|_| format!("Invalid port '{}'", s))?;
        Ok(("0.0.0.0".to_string(), port))
    }
}

// ============================================================================
// Logging
// ============================================================================

fn install_logger(
    level_str: &str,
    log_file: Option<&str>,
    with_color: bool,
) -> std::io::Result<()> {
    let level_str = level_str.to_uppercase();

    // SAFETY: env_logger reads RUST_LOG once at init; this runs before init.
    unsafe {
        if std::env::var("RUST_LOG").is_err() {
            std::env::set_var("RUST_LOG", &level_str);
        }
    }

    let mut builder = env_logger::Builder::from_default_env();

    if let Some(path) = log_file {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        builder.target(env_logger::Target::Pipe(Box::new(file)));
    }

    builder.format(move |buf, record| {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let level = record.level();
        // Replace newlines with a visible escape so each log entry stays on one line.
        let msg = record.args().to_string().replace('\n', "\\n");

        if with_color {
            let level_style = match level {
                Level::Error => Style::new().fg(Color::Red).bold(),
                Level::Warn => Style::new().fg(Color::Yellow).bold(),
                Level::Info => Style::new().fg(Color::Green).bold(),
                Level::Debug => Style::new().fg(Color::Cyan),
                Level::Trace => Style::new().fg(Color::Purple),
            };
            let dim = Style::new().dimmed();
            writeln!(
                buf,
                "{} {} {}",
                dim.paint(format!("[{}]", ts)),
                level_style.paint(format!("{:5}", level)),
                msg
            )
        } else {
            writeln!(buf, "[{}] {:5} {}", ts, level, msg)
        }
    });

    builder.init();
    Ok(())
}

// ============================================================================
// Shared application state
// ============================================================================

struct AppState {
    /// Limits in-flight AI searches to the configured worker count.
    permits: Arc<Semaphore>,
    /// Snapshot used by /ready and the HAProxy agent: true once all permits are taken.
    busy: AtomicBool,
    report_scoring: bool,
    start_time: Instant,
}

impl AppState {
    fn new(workers: usize, report_scoring: bool) -> Self {
        AppState {
            permits: Arc::new(Semaphore::new(workers)),
            busy: AtomicBool::new(false),
            report_scoring,
            start_time: Instant::now(),
        }
    }

    fn refresh_busy(&self) {
        self.busy
            .store(self.permits.available_permits() == 0, Ordering::Relaxed);
    }
}

// ============================================================================
// Handlers
// ============================================================================

async fn handle_health(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let uptime = data.start_time.elapsed().as_secs();
    let body = json_api::health_response(uptime);
    debug!("health endpoint: uptime={}s", uptime);
    HttpResponse::Ok()
        .content_type("application/json")
        .body(body)
}

async fn handle_ready(data: web::Data<Arc<AppState>>) -> HttpResponse {
    if data.busy.load(Ordering::Relaxed) {
        debug!("readiness probe: busy (all worker slots in use)");
        HttpResponse::ServiceUnavailable()
            .content_type("application/json")
            .body(r#"{"status":"busy"}"#)
    } else {
        debug!("readiness probe: ready");
        HttpResponse::Ok()
            .content_type("application/json")
            .body(r#"{"status":"ready"}"#)
    }
}

async fn handle_play(
    _req: HttpRequest,
    body: web::Bytes,
    data: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let request_start = Instant::now();

    // Parent span for the whole request. Marked active so the two child
    // spans below nest under it without explicit context plumbing.
    let mut parent = telemetry::start_span("gomoku.play");
    parent.set_attribute(KeyValue::new("http.route", "/gomoku/play"));
    parent.set_attribute(KeyValue::new("http.method", "POST"));
    parent.set_attribute(KeyValue::new("http.request.body_size", body.len() as i64));
    let _parent_guard = mark_span_as_active(parent);

    // Annotate the parent via the active context (we no longer own `parent`).
    let parent_set = |kv: KeyValue| Context::current().span().set_attribute(kv);
    let parent_status = |s: Status| Context::current().span().set_status(s);

    // ------------------------------------------------------------------
    // request.parsing: receive bytes, UTF-8 check, JSON → GameState
    // ------------------------------------------------------------------
    let tracer = telemetry::tracer();
    // Err variant carries an HttpResponse (>128 bytes); box it to satisfy
    // clippy::result_large_err without churning the Ok path's size.
    type ParseErr = Box<(&'static str, i64, HttpResponse)>;
    let parse_outcome: Result<game::GameState, ParseErr> =
        tracer.in_span("request.parsing", |cx| {
            cx.span()
                .set_attribute(KeyValue::new("body.bytes", body.len() as i64));

            let body_str = match std::str::from_utf8(&body) {
                Ok(s) => s,
                Err(_) => {
                    warn!("invalid UTF-8 in request body ({} bytes)", body.len());
                    cx.span().set_status(Status::error("invalid_utf8"));
                    let resp = HttpResponse::BadRequest()
                        .content_type("application/json")
                        .body(json_api::error_response("Invalid UTF-8 in request body"));
                    return Err(Box::new(("invalid_utf8", 400_i64, resp)));
                }
            };

            if body_str.is_empty() {
                warn!("empty request body");
                cx.span().set_status(Status::error("empty_body"));
                let resp = HttpResponse::BadRequest()
                    .content_type("application/json")
                    .body(json_api::error_response("Request body is required"));
                return Err(Box::new(("empty_body", 400_i64, resp)));
            }

            debug!("received game state: {} bytes", body_str.len());

            match json_api::parse_game(body_str) {
                Ok(g) => {
                    cx.span()
                        .set_attribute(KeyValue::new("board.size", g.board_size as i64));
                    cx.span()
                        .set_attribute(KeyValue::new("moves.played", g.move_history.len() as i64));
                    Ok(g)
                }
                Err(e) => {
                    warn!("failed to parse game: {}", e);
                    cx.span().set_status(Status::error("parse_error"));
                    let resp = HttpResponse::BadRequest()
                        .content_type("application/json")
                        .body(json_api::error_response(&e));
                    Err(Box::new(("parse_error", 400_i64, resp)))
                }
            }
        });

    let mut game = match parse_outcome {
        Ok(g) => g,
        Err(boxed) => {
            let (reason, status, resp) = *boxed;
            parent_set(KeyValue::new("http.status_code", status));
            parent_status(Status::error(reason));
            return resp;
        }
    };

    parent_set(KeyValue::new("board.size", game.board_size as i64));
    parent_set(KeyValue::new(
        "moves.played",
        game.move_history.len() as i64,
    ));

    if json_api::has_winner(&game) {
        debug!("game already finished — returning unchanged state");
        parent_set(KeyValue::new("http.status_code", 200_i64));
        parent_set(KeyValue::new("game.already_finished", true));
        let response_json = json_api::serialize_game(&game);
        return HttpResponse::Ok()
            .content_type("application/json")
            .body(response_json);
    }

    let ai_player = game.current_player;
    let player_index = if ai_player == board::CELL_CROSSES {
        0
    } else {
        1
    };
    let player_label = if ai_player == board::CELL_CROSSES {
        "X"
    } else {
        "O"
    };
    parent_set(KeyValue::new("ai.player", player_label));

    if game.player_type[player_index] != game::PlayerType::AI {
        parent_set(KeyValue::new("http.status_code", 400_i64));
        parent_status(Status::error("non_ai_to_move"));
        return HttpResponse::BadRequest()
            .content_type("application/json")
            .body(json_api::error_response(
                "Next player is human; server only accepts AI to-move positions",
            ));
    }

    let saved_depth = game.max_depth;
    game.max_depth = game.depth_for_player[player_index];
    let depth_for_search = game.max_depth;
    let search_radius = game.search_radius;

    debug!(
        "ai-thinking: player={} move={} depth={} radius={}",
        player_label,
        game.move_history.len() + 1,
        depth_for_search,
        search_radius,
    );

    // Acquire a worker permit. Held only for the duration of the AI search;
    // refreshed busy flag exposes saturation to /ready and HAProxy agent-check.
    let permit = match data.permits.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => {
            error!("worker semaphore closed unexpectedly");
            parent_set(KeyValue::new("http.status_code", 500_i64));
            parent_status(Status::error("semaphore_closed"));
            return HttpResponse::InternalServerError()
                .content_type("application/json")
                .body(json_api::error_response("Server shutting down"));
        }
    };
    let queue_wait_ms = request_start.elapsed().as_secs_f64() * 1000.0;
    data.refresh_busy();

    let report_scoring = data.report_scoring;
    let state_for_release = data.clone();

    // ------------------------------------------------------------------
    // move.computation: runs on a blocking thread. Capture the parent
    // context here and reattach it inside the worker so the child span
    // nests under gomoku.play even across the thread boundary.
    // ------------------------------------------------------------------
    let parent_cx = Context::current();
    let result = tokio::task::spawn_blocking(move || {
        let _cx_guard = parent_cx.attach();
        let tracer = telemetry::tracer();
        tracer.in_span("move.computation", |cx| {
            cx.span()
                .set_attribute(KeyValue::new("ai.player", player_label));
            cx.span()
                .set_attribute(KeyValue::new("ai.depth", depth_for_search as i64));
            cx.span()
                .set_attribute(KeyValue::new("ai.radius", search_radius as i64));
            let r = run_search(game, ai_player);
            match &r {
                Ok(out) => {
                    cx.span().set_attribute(KeyValue::new(
                        "ai.moves_evaluated",
                        out.moves_evaluated as i64,
                    ));
                    cx.span()
                        .set_attribute(KeyValue::new("ai.elapsed_seconds", out.elapsed_time));
                    cx.span()
                        .set_attribute(KeyValue::new("ai.move_type", out.move_type.clone()));
                    cx.span()
                        .set_attribute(KeyValue::new("ai.best_x", out.best_x as i64));
                    cx.span()
                        .set_attribute(KeyValue::new("ai.best_y", out.best_y as i64));
                }
                Err(e) => cx.span().set_status(Status::error(e.clone())),
            }
            r
        })
    })
    .await;
    drop(permit);
    state_for_release.refresh_busy();

    let SearchOutcome {
        mut game,
        best_x,
        best_y,
        scoring_report,
        move_type,
        elapsed_time,
        own_score,
        opp_score,
        moves_evaluated,
    } = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            error!("ai compute failure: {}", e);
            parent_set(KeyValue::new("http.status_code", 500_i64));
            parent_status(Status::error("ai_compute_failure"));
            return HttpResponse::InternalServerError()
                .content_type("application/json")
                .body(json_api::error_response(&e));
        }
        Err(join_err) => {
            error!("ai compute task panicked: {}", join_err);
            parent_set(KeyValue::new("http.status_code", 500_i64));
            parent_status(Status::error("ai_compute_panic"));
            return HttpResponse::InternalServerError()
                .content_type("application/json")
                .body(json_api::error_response("AI compute task panicked"));
        }
    };

    game.max_depth = saved_depth;

    if !game.make_move(
        best_x,
        best_y,
        ai_player,
        elapsed_time,
        moves_evaluated,
        own_score,
        opp_score,
    ) {
        error!("failed to apply ai move at [{},{}]", best_x, best_y);
        parent_set(KeyValue::new("http.status_code", 500_i64));
        parent_status(Status::error("apply_move_failed"));
        return HttpResponse::InternalServerError()
            .content_type("application/json")
            .body(json_api::error_response("Failed to apply AI move"));
    }

    if queue_wait_ms > 0.0
        && let Some(last) = game.move_history.last_mut()
    {
        last.queue_wait_ms = queue_wait_ms;
    }

    game.check_game_state();

    let mut winner_label: Option<&'static str> = None;
    if json_api::has_winner(&game) {
        if let Some(last) = game.move_history.last_mut() {
            last.is_winner = true;
        }
        winner_label = Some(match game.game_state {
            game::GAME_X_WIN => "X",
            game::GAME_O_WIN => "O",
            _ => "draw",
        });
    }

    let player_depth = game.depth_for_player[player_index];
    let pipeline = scoring_report
        .entries
        .iter()
        .map(|e| {
            let mark = if e.decisive { "*" } else { "" };
            format!("{}({:.2}ms){}", e.evaluator, e.time_ms, mark)
        })
        .collect::<Vec<_>>()
        .join(" -> ");

    let request_latency_secs = request_start.elapsed().as_secs_f64();
    info!(
        "play: player={} move=[{},{}] type={} depth={} radius={} evals={} time={:.3}s queue={:.2}ms pipeline={} request latency [{:.3} seconds]",
        if ai_player == board::CELL_CROSSES {
            "X"
        } else {
            "O"
        },
        best_x,
        best_y,
        move_type,
        player_depth,
        game.search_radius,
        moves_evaluated,
        elapsed_time,
        queue_wait_ms,
        pipeline,
        request_latency_secs,
    );

    if let Some(w) = winner_label {
        info!(
            "game over: winner={} after {} moves",
            w,
            game.move_history.len()
        );
    }

    parent_set(KeyValue::new("http.status_code", 200_i64));
    parent_set(KeyValue::new("ai.move_type", move_type.clone()));
    parent_set(KeyValue::new("ai.elapsed_seconds", elapsed_time));
    parent_set(KeyValue::new("ai.moves_evaluated", moves_evaluated as i64));
    parent_set(KeyValue::new("ai.depth", player_depth as i64));
    parent_set(KeyValue::new("request.queue_wait_ms", queue_wait_ms));
    parent_set(KeyValue::new(
        "request.latency_seconds",
        request_latency_secs,
    ));
    if let Some(w) = winner_label {
        parent_set(KeyValue::new("game.winner", w));
    }

    let report_ref = if report_scoring {
        Some(&scoring_report)
    } else {
        None
    };
    let response_json = json_api::serialize_game_ex(&game, report_ref, elapsed_time);

    HttpResponse::Ok()
        .content_type("application/json")
        .body(response_json)
}

async fn handle_not_found() -> HttpResponse {
    HttpResponse::NotFound()
        .content_type("application/json")
        .body(json_api::error_response("Not found"))
}

// ============================================================================
// AI search wrapper (runs on a blocking thread)
// ============================================================================

struct SearchOutcome {
    game: game::GameState,
    best_x: i32,
    best_y: i32,
    scoring_report: ai::ScoringReport,
    move_type: String,
    elapsed_time: f64,
    own_score: i32,
    opp_score: i32,
    moves_evaluated: i32,
}

fn run_search(mut game: game::GameState, ai_player: i32) -> Result<SearchOutcome, String> {
    let start_time = Instant::now();
    game.search_start = Some(start_time);
    game.search_timed_out = false;

    let (best_x, best_y, scoring_report, move_type) = if game.move_history.is_empty() {
        let center = (game.board_size / 2) as i32;
        (
            center,
            center,
            ai::ScoringReport::default(),
            "center".to_string(),
        )
    } else {
        let ((bx, by), report, mtype) = ai::find_best_ai_move(&mut game);
        (bx, by, report, mtype)
    };

    if best_x < 0 || best_y < 0 {
        return Err("AI failed to find a valid move".to_string());
    }

    let own_score = eval::evaluate_threat_fast(&game.board, best_x, best_y, ai_player);
    let opp_score = eval::evaluate_threat_fast(&game.board, best_x, best_y, -ai_player);
    let moves_evaluated = game.last_ai_moves_evaluated;
    let elapsed_time = start_time.elapsed().as_secs_f64();

    Ok(SearchOutcome {
        game,
        best_x,
        best_y,
        scoring_report,
        move_type,
        elapsed_time,
        own_score,
        opp_score,
        moves_evaluated,
    })
}

// ============================================================================
// HAProxy agent-check thread
// ============================================================================

async fn agent_check_loop(listener: TcpListener, app: Arc<AppState>) {
    info!("agent-check: listening for HAProxy probes");
    loop {
        match listener.accept().await {
            Ok((mut stream, _addr)) => {
                let status = if app.busy.load(Ordering::Relaxed) {
                    "drain\n"
                } else {
                    "ready\n"
                };
                let _ = stream.write_all(status.as_bytes()).await;
            }
            Err(e) => {
                error!("agent accept error: {}", e);
            }
        }
    }
}

// ============================================================================
// Main
// ============================================================================

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let cli = Cli::parse();

    let with_color = !cli.no_color && std::env::var("NO_COLOR").is_err();
    install_logger(&cli.log_level, cli.log_file.as_deref(), with_color)?;

    // Honeycomb / OpenTelemetry. Silent no-op unless the two PRODUCTION_*
    // env vars are set; safe to call before any spans are opened.
    let telemetry_enabled = telemetry::init_tracer(DAEMON_VERSION);

    let (host, port) = parse_bind_address(&cli.bind).unwrap_or_else(|e| {
        eprintln!("Error: {}", e);
        eprintln!("Expected format: host:port or just port");
        std::process::exit(1);
    });

    let detected_cores = available_parallelism().map(|n| n.get()).unwrap_or(2);
    let workers = cli.max_concurrency.unwrap_or(detected_cores).max(1);

    let app_state = Arc::new(AppState::new(workers, cli.report_scoring));

    if cli.report_scoring {
        info!("scoring reports enabled in JSON responses");
    }
    info!(
        "config: workers={} (detected_cores={}) report_scoring={} log_level={} telemetry={}",
        workers,
        detected_cores,
        cli.report_scoring,
        cli.log_level,
        if telemetry_enabled {
            "honeycomb"
        } else {
            "disabled"
        }
    );

    if cli.daemonize {
        warn!("--daemonize is accepted for CLI parity but has no effect in this build");
    }

    if let Some(agent_port) = cli.agent_port {
        let agent_addr = format!("{}:{}", host, agent_port);
        let listener = TcpListener::bind(&agent_addr).await.unwrap_or_else(|e| {
            eprintln!("Error: failed to bind agent-check to {}: {}", agent_addr, e);
            std::process::exit(1);
        });
        info!("haproxy agent-check listening on {}", agent_addr);

        let state_clone = app_state.clone();
        tokio::spawn(async move {
            agent_check_loop(listener, state_clone).await;
        });
    }

    info!("gomoku-httpd-rust v{} starting", DAEMON_VERSION);
    info!("listening on {}:{}", host, port);

    let state_for_server = app_state.clone();

    let server_result = HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .max_age(86400);

        App::new()
            .wrap(cors)
            .app_data(web::Data::new(state_for_server.clone()))
            .app_data(web::PayloadConfig::new(1024 * 1024))
            .route("/health", web::get().to(handle_health))
            .route("/ready", web::get().to(handle_ready))
            .route("/gomoku/play", web::post().to(handle_play))
            .default_service(web::to(handle_not_found))
    })
    .workers(workers)
    .bind(format!("{}:{}", host, port))?
    .run()
    .await;

    // Flush pending Honeycomb spans on graceful shutdown. No-op when the
    // tracer was never installed (env vars unset).
    if telemetry_enabled {
        telemetry::shutdown();
    }

    server_result
}
