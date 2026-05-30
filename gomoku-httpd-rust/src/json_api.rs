//! JSON parsing and serialization for the HTTP API.
//!
//! Ported from json_api.c — handles game state to/from JSON.

use crate::ai::ScoringReport;
use crate::board::{
    CELL_CROSSES, CELL_NAUGHTS, coord_to_notation, notation_to_coord, other_player,
};
use crate::game::{GAME_DRAW, GAME_O_WIN, GAME_X_WIN, GameState, PlayerType};
use serde_json::{Map, Value, json};

pub const API_VERSION: &str = "1.0.0";
pub const API_MAX_DEPTH: i32 = 6;
pub const API_MAX_RADIUS: i32 = 4;

/// Convert seconds to milliseconds with 3 decimal places (microsecond precision).
fn ms_from_seconds(seconds: f64) -> f64 {
    (seconds * 1_000_000.0).round() / 1000.0
}

/// Format milliseconds value as a string with exactly 3 decimal places.
fn ms_value(seconds: f64) -> Value {
    let ms = ms_from_seconds(seconds);
    // Use serde_json Number for precision
    let s = format!("{:.3}", ms);
    Value::Number(
        serde_json::Number::from_f64(s.parse::<f64>().unwrap_or(ms))
            .unwrap_or_else(|| serde_json::Number::from(0)),
    )
}

/// Parse player configuration from a JSON object.
fn parse_player_config(player_obj: &Value) -> Result<(PlayerType, i32), String> {
    let player_str = player_obj
        .get("player")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'player' field")?;

    let player_type = match player_str.to_ascii_lowercase().as_str() {
        "ai" => PlayerType::AI,
        "human" => PlayerType::Human,
        _ => return Err("Invalid player type: expected 'human' or 'AI'".to_string()),
    };

    let depth = player_obj
        .get("depth")
        .and_then(|v| v.as_i64())
        .map(|d| d as i32)
        .unwrap_or(-1);

    Ok((player_type, depth))
}

/// Parse incoming JSON and create a GameState by replaying moves.
pub fn parse_game(json_str: &str) -> Result<GameState, String> {
    let root: Value =
        serde_json::from_str(json_str).map_err(|e| format!("Invalid JSON syntax: {}", e))?;

    // Board size
    let board_size = root
        .get("board_size")
        .and_then(|v| v.as_i64())
        .map(|s| s as usize)
        .unwrap_or(19);

    if board_size != 15 && board_size != 19 {
        return Err("Invalid board size: must be 15 or 19".to_string());
    }

    // Player configs (required)
    let x_obj = root.get("X").ok_or("Missing required field: X")?;
    let o_obj = root.get("O").ok_or("Missing required field: O")?;

    if x_obj.get("player").is_none() {
        return Err("Missing required field: X.player".to_string());
    }
    if o_obj.get("player").is_none() {
        return Err("Missing required field: O.player".to_string());
    }

    let (player_x_type, depth_x) = parse_player_config(x_obj)?;
    let (player_o_type, depth_o) = parse_player_config(o_obj)?;

    // Radius (cap). Default 3 matches the gomoku-c CLI default; using 2 here
    // would silently weaken the AI relative to the C version when clients
    // omit the field.
    let mut radius = root
        .get("radius")
        .and_then(|v| v.as_i64())
        .map(|r| r as i32)
        .unwrap_or(3);
    if radius > API_MAX_RADIUS {
        radius = API_MAX_RADIUS;
    }
    if radius < 1 {
        radius = 1;
    }

    // Cap depths
    let depth_x = if depth_x > API_MAX_DEPTH {
        API_MAX_DEPTH
    } else {
        depth_x
    };
    let depth_o = if depth_o > API_MAX_DEPTH {
        API_MAX_DEPTH
    } else {
        depth_o
    };

    // Timeout
    let timeout = root
        .get("timeout")
        .and_then(|v| v.as_i64())
        .map(|t| t as i32)
        .unwrap_or(0);

    // Undo
    let enable_undo = root.get("undo").and_then(|v| v.as_bool()).unwrap_or(true);

    let max_undo_allowed = root
        .get("undo_limit")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32)
        .unwrap_or(5);

    // Create game state
    let mut game = GameState::new(
        board_size,
        API_MAX_DEPTH,
        timeout,
        radius,
        player_x_type,
        player_o_type,
        if depth_x > 0 { depth_x } else { API_MAX_DEPTH },
        if depth_o > 0 { depth_o } else { API_MAX_DEPTH },
        enable_undo,
        max_undo_allowed,
    );

    // Parse and replay moves
    if let Some(moves_arr) = root.get("moves").and_then(|v| v.as_array()) {
        for move_obj in moves_arr {
            let obj = match move_obj.as_object() {
                Some(o) => o,
                None => continue,
            };

            let mut x: i32 = -1;
            let mut y: i32 = -1;
            let mut player: i32 = 0;
            let mut time_taken: f64 = 0.0;
            let mut positions_evaluated: i32 = 0;
            let mut own_score: i32 = 0;
            let mut opponent_score: i32 = 0;
            let mut queue_wait_ms: f64 = 0.0;

            for (key, val) in obj {
                // Check for position value (string notation or legacy array)
                if let Some(coord_str) = val.as_str() {
                    if let Some((rx, ry)) = notation_to_coord(coord_str, board_size) {
                        x = rx as i32;
                        y = ry as i32;
                        if key.starts_with('X') {
                            player = CELL_CROSSES;
                        } else if key.starts_with('O') {
                            player = CELL_NAUGHTS;
                        }
                    }
                } else if let Some(arr) = val.as_array()
                    && arr.len() == 2
                    && let (Some(ax), Some(ay)) = (arr[0].as_i64(), arr[1].as_i64())
                {
                    x = ax as i32;
                    y = ay as i32;
                    if key.starts_with('X') {
                        player = CELL_CROSSES;
                    } else if key.starts_with('O') {
                        player = CELL_NAUGHTS;
                    }
                }

                match key.as_str() {
                    "time_ms" => {
                        if let Some(t) = val.as_f64() {
                            time_taken = t / 1000.0;
                        }
                    }
                    "moves_evaluated" | "moves_searched" => {
                        if let Some(n) = val.as_i64() {
                            positions_evaluated = n as i32;
                        }
                    }
                    "score" => {
                        if let Some(n) = val.as_i64() {
                            own_score = n as i32;
                        }
                    }
                    "opponent" => {
                        if let Some(n) = val.as_i64() {
                            opponent_score = n as i32;
                        }
                    }
                    "queue_wait_ms" => {
                        if let Some(q) = val.as_f64() {
                            queue_wait_ms = q;
                        }
                    }
                    _ => {}
                }
            }

            if x >= 0 && y >= 0 && player != 0 {
                if !game.make_move(
                    x,
                    y,
                    player,
                    time_taken,
                    positions_evaluated,
                    own_score,
                    opponent_score,
                ) {
                    return Err(format!("Invalid move at position [{}, {}]", x, y));
                }
                // Preserve queue_wait_ms from client
                if queue_wait_ms > 0.0
                    && let Some(last) = game.move_history.last_mut()
                {
                    last.queue_wait_ms = queue_wait_ms;
                }
            }
        }
    }

    // Check game state after replaying moves
    game.check_game_state();

    // Set current player to opposite of last move
    if !game.move_history.is_empty() {
        let last_player = game.move_history.last().unwrap().player;
        game.current_player = other_player(last_player);
    }

    Ok(game)
}

/// Serialize game state to JSON string.
pub fn serialize_game(game: &GameState) -> String {
    serialize_game_ex(game, None, 0.0)
}

/// Extended serialization with optional scoring report for the latest AI move.
pub fn serialize_game_ex(
    game: &GameState,
    report: Option<&ScoringReport>,
    total_time_sec: f64,
) -> String {
    let mut root = Map::new();

    // Player X configuration
    let mut player_x = Map::new();
    player_x.insert(
        "player".to_string(),
        json!(if game.player_type[0] == PlayerType::Human {
            "human"
        } else {
            "AI"
        }),
    );
    if game.player_type[0] == PlayerType::AI {
        player_x.insert("depth".to_string(), json!(game.depth_for_player[0]));
    }
    player_x.insert("time_ms".to_string(), ms_value(game.total_x_time));
    root.insert("X".to_string(), Value::Object(player_x));

    // Player O configuration
    let mut player_o = Map::new();
    player_o.insert(
        "player".to_string(),
        json!(if game.player_type[1] == PlayerType::Human {
            "human"
        } else {
            "AI"
        }),
    );
    if game.player_type[1] == PlayerType::AI {
        player_o.insert("depth".to_string(), json!(game.depth_for_player[1]));
    }
    player_o.insert("time_ms".to_string(), ms_value(game.total_o_time));
    root.insert("O".to_string(), Value::Object(player_o));

    // Game parameters
    root.insert("board_size".to_string(), json!(game.board_size));
    root.insert("radius".to_string(), json!(game.search_radius));

    if game.move_timeout > 0 {
        root.insert("timeout".to_string(), json!(game.move_timeout));
    } else {
        root.insert("timeout".to_string(), json!("none"));
    }

    root.insert("undo".to_string(), json!(game.enable_undo));
    root.insert("undo_limit".to_string(), json!(game.max_undo_allowed));

    // Winner
    let winner_str = match game.game_state {
        GAME_X_WIN => "X",
        GAME_O_WIN => "O",
        GAME_DRAW => "draw",
        _ => "none",
    };
    root.insert("winner".to_string(), json!(winner_str));

    // Board state
    let board_rows = game.board.to_row_strings();
    root.insert("board_state".to_string(), json!(board_rows));

    // Moves array
    let mut moves_array = Vec::new();
    let move_count = game.move_history.len();

    for (i, mv) in game.move_history.iter().enumerate() {
        let mut move_obj = Map::new();

        // Player identifier
        let player_index = if mv.player == CELL_CROSSES { 0 } else { 1 };
        let is_ai = game.player_type[player_index] == PlayerType::AI;

        let player_name = if mv.player == CELL_CROSSES {
            if is_ai { "X (AI)" } else { "X (human)" }
        } else {
            if is_ai { "O (AI)" } else { "O (human)" }
        };

        // Position in compact notation
        if let Some(notation) = coord_to_notation(mv.x as usize, mv.y as usize, game.board_size) {
            move_obj.insert(player_name.to_string(), json!(notation));
        }

        // AI-specific fields
        if is_ai && mv.positions_evaluated > 0 {
            move_obj.insert("moves_evaluated".to_string(), json!(mv.positions_evaluated));
        }
        if is_ai && mv.own_score != 0 {
            move_obj.insert("score".to_string(), json!(mv.own_score));
        }
        if is_ai && mv.opponent_score != 0 {
            move_obj.insert("opponent".to_string(), json!(mv.opponent_score));
        }

        // Time taken
        move_obj.insert("time_ms".to_string(), ms_value(mv.time_taken));

        // Queue wait time
        if mv.queue_wait_ms > 0.0 {
            let q = format!("{:.3}", mv.queue_wait_ms);
            move_obj.insert(
                "queue_wait_ms".to_string(),
                Value::Number(
                    serde_json::Number::from_f64(q.parse::<f64>().unwrap_or(mv.queue_wait_ms))
                        .unwrap_or_else(|| serde_json::Number::from(0)),
                ),
            );
        }

        // Winner flag
        if mv.is_winner {
            move_obj.insert("winner".to_string(), json!(true));
        }

        // Scoring report on last move
        if let Some(rep) = report
            && i == move_count - 1
            && is_ai
        {
            move_obj.insert(
                "offensive_max_score".to_string(),
                json!(rep.offensive_max_score),
            );
            move_obj.insert(
                "defensive_max_score".to_string(),
                json!(rep.defensive_max_score),
            );

            if total_time_sec > 0.0 {
                move_obj.insert("think_time_ms".to_string(), ms_value(total_time_sec));
            }

            // Scoring entries
            let mut scoring_arr = Vec::new();
            for se in &rep.entries {
                let mut se_obj = Map::new();
                se_obj.insert(
                    "player".to_string(),
                    json!(if se.is_current_player {
                        "current"
                    } else {
                        "opponent"
                    }),
                );
                se_obj.insert("evaluator".to_string(), json!(se.evaluator));
                se_obj.insert("evaluated_moves".to_string(), json!(se.evaluated_moves));
                se_obj.insert("score".to_string(), json!(se.score));

                let t = format!("{:.3}", se.time_ms);
                se_obj.insert(
                    "time_ms".to_string(),
                    Value::Number(
                        serde_json::Number::from_f64(t.parse::<f64>().unwrap_or(se.time_ms))
                            .unwrap_or_else(|| serde_json::Number::from(0)),
                    ),
                );

                if se.have_win {
                    se_obj.insert("have_win".to_string(), json!(true));
                }
                if se.have_vct {
                    se_obj.insert("have_vct".to_string(), json!(true));
                    if !se.vct_sequence.is_empty() {
                        let vct_arr: Vec<Value> = se
                            .vct_sequence
                            .iter()
                            .map(|&(vx, vy)| json!([vx, vy]))
                            .collect();
                        se_obj.insert("vct_sequence".to_string(), Value::Array(vct_arr));
                    }
                }
                if se.decisive {
                    se_obj.insert("decisive".to_string(), json!(true));
                }

                scoring_arr.push(Value::Object(se_obj));
            }
            move_obj.insert("scoring".to_string(), Value::Array(scoring_arr));
        }

        moves_array.push(Value::Object(move_obj));
    }

    root.insert("moves".to_string(), Value::Array(moves_array));

    serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_else(|_| "{}".to_string())
}

/// Create error response JSON.
pub fn error_response(message: &str) -> String {
    json!({"error": message}).to_string()
}

/// Create health check response JSON.
pub fn health_response(uptime_secs: u64) -> String {
    let uptime = format_uptime(uptime_secs);
    json!({
        "status": "ok",
        "version": API_VERSION,
        "uptime": uptime,
    })
    .to_string()
}

/// Check if the game already has a winner or is drawn.
pub fn has_winner(game: &GameState) -> bool {
    matches!(game.game_state, GAME_X_WIN | GAME_O_WIN | GAME_DRAW)
}

/// Format uptime as a human-readable string.
pub fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    if days > 0 {
        format!("{}d {}h {}m {}s", days, hours, minutes, secs)
    } else if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, secs)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, secs)
    } else {
        format!("{}s", secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn parse_str(s: &str) -> Value {
        serde_json::from_str(s).expect("invalid JSON")
    }

    #[test]
    fn empty_game_round_trips() {
        let req = r#"{
            "X": {"player": "AI", "depth": 3},
            "O": {"player": "human"},
            "board_size": 15,
            "radius": 2,
            "moves": []
        }"#;
        let game = parse_game(req).expect("parse_game");
        assert_eq!(game.board_size, 15);
        assert_eq!(game.search_radius, 2);
        assert_eq!(game.move_history.len(), 0);

        let out = serialize_game(&game);
        let v = parse_str(&out);
        assert_eq!(v["board_size"], 15);
        assert_eq!(v["radius"], 2);
        assert_eq!(v["winner"], "none");
        assert_eq!(v["X"]["player"], "AI");
        assert_eq!(v["O"]["player"], "human");
        assert!(v["board_state"].is_array());
    }

    #[test]
    fn invalid_board_size_is_rejected() {
        let req = r#"{
            "X": {"player": "AI"},
            "O": {"player": "human"},
            "board_size": 17
        }"#;
        let err = parse_game(req).err().expect("expected error");
        assert!(err.contains("board size"));
    }

    #[test]
    fn missing_player_field_is_rejected() {
        let req = r#"{"O": {"player": "human"}, "board_size": 15}"#;
        let err = parse_game(req).err().expect("expected error");
        assert!(err.contains("X"), "got: {}", err);
    }

    #[test]
    fn replays_compact_notation_with_one_indexed_rows() {
        // K9 — column K (index 9), display row 9 → internal x=8, y=9.
        let req = r#"{
            "X": {"player": "human"},
            "O": {"player": "AI", "depth": 3},
            "board_size": 15,
            "moves": [{"X (human)": "K9", "time_ms": 100.0}]
        }"#;
        let game = parse_game(req).expect("parse_game");
        assert_eq!(game.move_history.len(), 1);
        let m = &game.move_history[0];
        assert_eq!((m.x, m.y), (8, 9));
        // Now-O turn.
        assert_eq!(game.current_player, -1);

        // Round-trip: serialize back and confirm we still see "K9".
        let out = serialize_game(&game);
        let v = parse_str(&out);
        let move0 = &v["moves"][0];
        assert_eq!(move0["X (human)"], "K9");
    }

    #[test]
    fn replay_legacy_array_coords() {
        let req = r#"{
            "X": {"player": "AI", "depth": 3},
            "O": {"player": "human"},
            "board_size": 15,
            "moves": [{"X (AI)": [4, 5], "time_ms": 50}]
        }"#;
        let game = parse_game(req).expect("parse_game");
        assert_eq!(game.move_history.len(), 1);
        let m = &game.move_history[0];
        assert_eq!((m.x, m.y), (4, 5));
    }

    #[test]
    fn radius_clamps_to_api_max() {
        let req = r#"{
            "X": {"player": "AI"},
            "O": {"player": "human"},
            "board_size": 15,
            "radius": 99
        }"#;
        let game = parse_game(req).expect("parse_game");
        assert_eq!(game.search_radius, API_MAX_RADIUS);
    }

    #[test]
    fn depth_caps_to_api_max() {
        let req = r#"{
            "X": {"player": "AI", "depth": 99},
            "O": {"player": "human"},
            "board_size": 15
        }"#;
        let game = parse_game(req).expect("parse_game");
        assert_eq!(game.depth_for_player[0], API_MAX_DEPTH);
    }

    #[test]
    fn health_response_has_required_fields() {
        let v = parse_str(&health_response(125));
        assert_eq!(v["status"], "ok");
        assert_eq!(v["version"], API_VERSION);
        assert_eq!(v["uptime"], "2m 5s");
    }

    #[test]
    fn error_response_serializes() {
        let v = parse_str(&error_response("nope"));
        assert_eq!(v["error"], "nope");
    }

    #[test]
    fn format_uptime_handles_units() {
        assert_eq!(format_uptime(0), "0s");
        assert_eq!(format_uptime(45), "45s");
        assert_eq!(format_uptime(60), "1m 0s");
        assert_eq!(format_uptime(3661), "1h 1m 1s");
        assert_eq!(format_uptime(86400 + 3600), "1d 1h 0m 0s");
    }

    #[test]
    fn has_winner_flags_terminal_states() {
        let mut g = GameState::new(15, 4, 0, 2, PlayerType::AI, PlayerType::AI, 4, 4, true, 5);
        assert!(!has_winner(&g));
        g.game_state = GAME_DRAW;
        assert!(has_winner(&g));
    }
}
