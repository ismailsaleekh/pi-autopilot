use std::alloc::{GlobalAlloc, Layout, System};
use std::fs;
use std::io::{BufReader, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use drivers::runner::rpc::{
    CompactionReason, JsonlReader, RpcClient, RpcCommand, RpcCommandKind, RpcError, RpcEvent,
    RpcFrame, RpcProtocol, RpcSpawnConfig, launch_arguments,
};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

#[global_allocator]
static TRACKING_ALLOCATOR: TrackingAllocator = TrackingAllocator;

static ALLOC_CURRENT: AtomicUsize = AtomicUsize::new(0);
static ALLOC_PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOC_BASE: AtomicUsize = AtomicUsize::new(0);
static TEMP_ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TrackingAllocator;

unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            record_alloc(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        ALLOC_CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if !new_ptr.is_null() {
            if new_size >= layout.size() {
                record_alloc(new_size - layout.size());
            } else {
                ALLOC_CURRENT.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        new_ptr
    }
}

fn record_alloc(size: usize) {
    let current = ALLOC_CURRENT.fetch_add(size, Ordering::Relaxed) + size;
    let mut peak = ALLOC_PEAK.load(Ordering::Relaxed);
    while current > peak {
        match ALLOC_PEAK.compare_exchange_weak(peak, current, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => break,
            Err(next) => peak = next,
        }
    }
}

fn reset_alloc_peak() {
    let current = ALLOC_CURRENT.load(Ordering::Relaxed);
    ALLOC_BASE.store(current, Ordering::Relaxed);
    ALLOC_PEAK.store(current, Ordering::Relaxed);
}

fn alloc_peak_delta() -> usize {
    ALLOC_PEAK
        .load(Ordering::Relaxed)
        .saturating_sub(ALLOC_BASE.load(Ordering::Relaxed))
}

#[test]
fn runner_rpc_framing_lf_only_crlf_unicode_separators_utf8_chunks_and_large_frame() {
    let large = "x".repeat(225 * 1024);
    let input = format!(
        "{{\"type\":\"message_update\",\"text\":\"A\u{2028}B\u{2029}C\"}}\n{{\"type\":\"agent_settled\"}}\r\n{{\"type\":\"message_update\",\"text\":\"snowman ☃\"}}\n{{\"type\":\"message_update\",\"text\":\"{large}\"}}\n"
    );
    let chunked = ChunkedRead::new(input.into_bytes(), 3);
    let mut reader = JsonlReader::new(BufReader::with_capacity(2, chunked));

    let first = reader.next_record().expect("first record").expect("record");
    let first_text = String::from_utf8(first).expect("utf8");
    assert!(first_text.contains('\u{2028}'));
    assert!(first_text.contains('\u{2029}'));
    assert_eq!(first_text.matches("message_update").count(), 1);

    let second = reader
        .next_record()
        .expect("second record")
        .expect("record");
    assert_eq!(
        String::from_utf8(second).expect("utf8"),
        "{\"type\":\"agent_settled\"}"
    );

    let third = reader.next_record().expect("third record").expect("record");
    assert!(String::from_utf8(third).expect("utf8").contains('☃'));

    let fourth = reader
        .next_record()
        .expect("fourth record")
        .expect("record");
    assert!(fourth.len() > 224 * 1024);
    assert!(reader.next_record().expect("eof").is_none());
    assert_eq!(reader.frames, 4);
}

#[test]
fn runner_rpc_refuses_oversized_unterminated_and_message_update_frames_before_allocation() {
    let oversized = vec![b'x'; 65];
    let mut unterminated =
        JsonlReader::with_max_record_bytes(BufReader::new(oversized.as_slice()), 64);
    assert_eq!(
        unterminated.next_record(),
        Err(RpcError::FrameTooLarge {
            bytes: 65,
            limit: 64,
        })
    );
    assert!(unterminated.peak_line_capacity <= 64);

    let update = format!(
        "{{\"type\":\"message_update\",\"text\":\"{}\"}}\n",
        "x".repeat(65)
    );
    let mut message_update =
        JsonlReader::with_max_record_bytes(BufReader::new(update.as_bytes()), 64);
    assert!(matches!(
        message_update.next_record(),
        Err(RpcError::FrameTooLarge { limit: 64, .. })
    ));
}

#[test]
fn runner_rpc_spawn_rejects_a_terminal_ceiling_override_before_launch() {
    let root = temp_root("runner-rpc-hard-ceiling");
    let mut config = RpcSpawnConfig::new(
        root.clone(),
        "openai-codex".to_owned(),
        "gpt-5.3-codex".to_owned(),
        "high".to_owned(),
        "session-hard-ceiling".to_owned(),
        root.join("session"),
        vec!["read".to_owned()],
    );
    let mut stderr_config = config.clone();
    stderr_config.stderr_tail_bytes = drivers::runner::rpc::MAX_STDERR_TAIL_BYTES + 1;
    assert!(matches!(
        RpcClient::spawn(stderr_config),
        Err(RpcError::ProtocolViolation(detail)) if detail.contains("stderr tail limit")
    ));
    config.max_terminal_bytes = drivers::generated::pi_rpc::DEFAULT_MAX_TERMINAL_BYTES + 1;
    assert!(matches!(
        RpcClient::spawn(config),
        Err(RpcError::ProtocolViolation(detail)) if detail.contains("terminal byte limit")
    ));
    fs::remove_dir_all(root).expect("remove hard-ceiling fixture");
}

#[test]
fn runner_rpc_stderr_hard_ceiling_kills_the_child_and_rejects_the_run() {
    let root = temp_root("runner-rpc-stderr-ceiling");
    write_fake_pi(
        &root,
        r#"#!/usr/bin/env python3
import sys, time
sys.stderr.write("x" * 65)
sys.stderr.flush()
while True:
    time.sleep(10)
"#,
    );
    let mut config = test_spawn_config(&root);
    config.pi_executable = root.join("pi").into_os_string();
    config.stderr_tail_bytes = 64;
    let mut client = RpcClient::spawn(config).expect("spawn stderr fixture");
    assert_eq!(
        client.next_frame(),
        Err(RpcError::StderrTooLarge {
            bytes: 65,
            limit: 64,
        })
    );
    let diagnostics = client.diagnostics();
    assert_eq!(diagnostics.stderr_total_bytes, 65);
    assert_eq!(diagnostics.stderr_tail_bytes, 64);
    assert!(diagnostics.stderr_tail_truncated);
    assert!(matches!(
        client.shutdown(Duration::from_millis(50)),
        Err(RpcError::StderrTooLarge {
            bytes: 65,
            limit: 64
        })
    ));
    fs::remove_dir_all(root).expect("remove stderr fixture");
}

#[test]
fn runner_rpc_volume_drains_548_mb_without_retaining_nonterminal_frames_or_leaking_child_stdout() {
    let root = temp_root("runner-rpc-volume");
    write_fake_pi(&root, &volume_fake_pi());
    reset_alloc_peak();
    let mut client = spawn_fake_client(&root, 2 * 1024 * 1024);
    client
        .send_command(RpcCommand::prompt("p1", "run"))
        .expect("send prompt");
    let mut terminal = None;
    loop {
        match client.next_frame().expect("next frame") {
            Some(RpcFrame::Event(RpcEvent::MessageEnd { message })) => terminal = message.text,
            Some(RpcFrame::Event(RpcEvent::AgentSettled)) => break,
            Some(_) => {}
            None => panic!("fake pi ended before agent_settled"),
        }
    }
    assert_eq!(terminal.as_deref(), Some("TERMINAL_OK"));
    let diagnostics = client.diagnostics();
    let peak_allocation_delta = alloc_peak_delta();
    eprintln!(
        "runner_rpc_volume_diagnostics total_bytes={} message_update_frames={} terminal_payload_bytes={} retained_tail_bytes={} peak_line_bytes={} peak_line_capacity={} peak_allocation_delta={}",
        diagnostics.total_bytes,
        diagnostics.message_update_frames,
        diagnostics.terminal_payload_bytes,
        diagnostics.retained_tail_bytes,
        diagnostics.peak_line_bytes,
        diagnostics.peak_line_capacity,
        peak_allocation_delta
    );
    assert!(
        diagnostics.total_bytes >= 548 * 1024 * 1024,
        "{}",
        diagnostics.total_bytes
    );
    assert!(
        diagnostics.message_update_frames > 2_000,
        "{}",
        diagnostics.message_update_frames
    );
    assert!(
        diagnostics.terminal_payload_bytes >= "TERMINAL_OK".len()
            && diagnostics.terminal_payload_bytes < 4096,
        "{}",
        diagnostics.terminal_payload_bytes
    );
    assert!(
        diagnostics.retained_tail_bytes < 4096,
        "{}",
        diagnostics.retained_tail_bytes
    );
    assert!(
        diagnostics.peak_line_capacity < 1024 * 1024,
        "{}",
        diagnostics.peak_line_capacity
    );
    assert!(
        diagnostics.peak_line_bytes > 224 * 1024,
        "peak line should include the real temporary frame buffer, got {}",
        diagnostics.peak_line_bytes
    );
    assert!(
        peak_allocation_delta < 16 * 1024 * 1024,
        "peak allocation delta exceeded bound: {peak_allocation_delta}"
    );
    let shutdown = client.shutdown(Duration::from_secs(5)).expect("shutdown");
    assert!(!shutdown.escalated);
}

#[test]
fn bug_185_entry_appended_is_typed_bounded_and_bootstrap_only() {
    let receipt = r#"{"type":"entry_appended","entry":{"type":"custom","customType":"pi-autopilot:child-tools","data":{"self_digest":"abc","binding":"def","active_tools":["read"]},"id":"receipt-1","parentId":null,"timestamp":"2026-07-30T00:00:00.000Z"}}"#;

    let mut protocol = RpcProtocol::new(1024 * 1024);
    let frame = protocol
        .ingest_record(receipt.as_bytes())
        .expect("known bootstrap entry");
    let RpcFrame::Event(RpcEvent::EntryAppended { entry }) = frame else {
        panic!("expected typed entry_appended event");
    };
    assert_eq!(entry.id, "receipt-1");
    assert_eq!(entry.custom_type, "pi-autopilot:child-tools");
    assert_eq!(entry.data["active_tools"], serde_json::json!(["read"]));

    let duplicate = protocol
        .ingest_record(receipt.as_bytes())
        .expect_err("duplicate bootstrap entry rejected");
    assert!(matches!(duplicate, RpcError::ProtocolViolation(_)));

    let mut after_bootstrap = RpcProtocol::new(1024 * 1024);
    after_bootstrap.complete_bootstrap();
    let late = after_bootstrap
        .ingest_record(receipt.as_bytes())
        .expect_err("post-bootstrap entry rejected");
    assert!(matches!(late, RpcError::ProtocolViolation(_)));

    let oversized = format!(
        r#"{{"type":"entry_appended","entry":{{"type":"custom","customType":"pi-autopilot:child-tools","data":{{"padding":"{}"}},"id":"receipt-1"}}}}"#,
        "x".repeat(20 * 1024)
    );
    let mut bounded = RpcProtocol::new(1024 * 1024);
    let too_large = bounded
        .ingest_record(oversized.as_bytes())
        .expect_err("oversized entry rejected");
    assert!(matches!(too_large, RpcError::EntryAppendedTooLarge { .. }));

    let mut unknown = RpcProtocol::new(1024 * 1024);
    let error = unknown
        .ingest_record(br#"{"type":"future_unrecognized_event"}"#)
        .expect_err("truly unknown events remain fatal");
    assert!(matches!(error, RpcError::UnknownFrame(_)));
}

#[test]
fn runner_rpc_ordering_accepts_retry_after_agent_end_until_agent_settled() {
    let mut protocol = RpcProtocol::new(1024 * 1024);
    for frame in [
        r#"{"type":"agent_start"}"#,
        r#"{"type":"agent_end","messages":[],"willRetry":true}"#,
        r#"{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":1,"errorMessage":"x"}"#,
        r#"{"type":"auto_retry_end","success":true,"attempt":1}"#,
        r#"{"type":"agent_start"}"#,
        r#"{"type":"agent_end","messages":[],"willRetry":false}"#,
        r#"{"type":"agent_settled"}"#,
    ] {
        protocol.ingest_record(frame.as_bytes()).expect(frame);
    }
    protocol.finish().expect("settled stream finishes");
}

#[test]
fn runner_rpc_ordering_rejects_event_after_settled_missing_settled_and_malformed_frame() {
    let mut after_settled = RpcProtocol::new(1024 * 1024);
    for frame in [
        r#"{"type":"agent_start"}"#,
        r#"{"type":"agent_end","messages":[],"willRetry":false}"#,
        r#"{"type":"agent_settled"}"#,
    ] {
        after_settled.ingest_record(frame.as_bytes()).expect(frame);
    }
    let error = after_settled
        .ingest_record(br#"{"type":"queue_update","steering":[],"followUp":[]}"#)
        .expect_err("event after settled rejected");
    assert!(matches!(error, RpcError::OutOfOrderEvent(_)));

    let mut missing = RpcProtocol::new(1024 * 1024);
    missing
        .ingest_record(br#"{"type":"agent_start"}"#)
        .expect("start");
    missing
        .ingest_record(br#"{"type":"agent_end","messages":[],"willRetry":false}"#)
        .expect("end");
    let error = missing.finish().expect_err("missing settled rejected");
    assert!(matches!(error, RpcError::OutOfOrderEvent(_)));

    let mut malformed = RpcProtocol::new(1024 * 1024);
    let error = malformed
        .ingest_record(br#"{"type":"agent_start""#)
        .expect_err("malformed frame rejected");
    assert!(matches!(error, RpcError::Json(_)));
}

#[test]
fn runner_rpc_correlation_rejects_mismatched_missing_and_duplicate_ids() {
    let mut mismatched = RpcProtocol::new(1024 * 1024);
    mismatched
        .register_request(&RpcCommand::get_state("want"))
        .expect("register");
    let error = mismatched
        .ingest_record(br#"{"id":"other","type":"response","command":"get_state","success":true}"#)
        .expect_err("mismatched id rejected");
    assert!(matches!(error, RpcError::UnmatchedResponse(id) if id == "other"));

    let mut missing = RpcProtocol::new(1024 * 1024);
    missing
        .register_request(&RpcCommand::get_session_stats("stats"))
        .expect("register");
    let error = missing.finish().expect_err("missing response rejected");
    assert!(matches!(error, RpcError::MissingResponse(ids) if ids == vec!["stats".to_owned()]));

    let mut duplicate = RpcProtocol::new(1024 * 1024);
    duplicate
        .register_request(&RpcCommand::prompt("dup", "one"))
        .expect("first register");
    let error = duplicate
        .register_request(&RpcCommand::prompt("dup", "two"))
        .expect_err("duplicate id rejected");
    assert!(matches!(error, RpcError::DuplicateRequest(id) if id == "dup"));
}

#[test]
fn runner_rpc_steer_success_is_queued_not_delivered() {
    let mut protocol = RpcProtocol::new(1024 * 1024);
    protocol
        .register_request(&RpcCommand::steer("s1", "checkpoint now"))
        .expect("register steer");
    let frame = protocol
        .ingest_record(br#"{"id":"s1","type":"response","command":"steer","success":true}"#)
        .expect("steer response");
    let RpcFrame::Response(response) = frame else {
        panic!("expected response");
    };
    assert_eq!(response.command, RpcCommandKind::Steer);
    assert!(response.queued_not_delivered);
}

#[test]
fn runner_rpc_protocol_violation_rejects_automatic_compaction_start() {
    for reason in [CompactionReason::Threshold, CompactionReason::Overflow] {
        let mut protocol = RpcProtocol::new(1024 * 1024);
        protocol
            .ingest_record(br#"{"type":"agent_start"}"#)
            .expect("start");
        let reason_text = match reason {
            CompactionReason::Threshold => "threshold",
            CompactionReason::Overflow => "overflow",
            CompactionReason::Manual => unreachable!(),
        };
        let frame = format!(r#"{{"type":"compaction_start","reason":"{reason_text}"}}"#);
        let error = protocol
            .ingest_record(frame.as_bytes())
            .expect_err("automatic compaction rejected");
        assert!(matches!(error, RpcError::ProtocolViolation(_)));
    }
}

#[test]
fn runner_rpc_spawn_uses_exact_rpc_flags_and_removes_metered_api_environment() {
    let root = temp_root("runner-rpc-flags");
    let argv_path = root.join("argv.json");
    let env_path = root.join("env.json");
    write_fake_pi(&root, &argv_env_fake_pi(&argv_path, &env_path));
    unsafe {
        std::env::set_var("OPENAI_API_KEY", "must-not-leak");
        std::env::set_var("OPENROUTER_API_KEY", "must-not-leak");
    }
    let mut client = spawn_fake_client(&root, 1024 * 1024);
    let shutdown = client.shutdown(Duration::from_secs(5)).expect("shutdown");
    unsafe {
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("OPENROUTER_API_KEY");
    }
    assert!(!shutdown.escalated);
    let argv = fs::read_to_string(argv_path).expect("argv file");
    let argv: serde_json::Value = serde_json::from_str(&argv).expect("argv json");
    assert_eq!(argv["args"][0], "--mode");
    assert_eq!(argv["args"][1], "rpc");
    for required in [
        "--session-id",
        "session-123",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.5",
        "--thinking",
        "high",
        "--tools",
        "read,ls",
    ] {
        assert!(
            argv["args"]
                .as_array()
                .expect("args")
                .iter()
                .any(|arg| arg == required),
            "missing {required}"
        );
    }
    let env = fs::read_to_string(env_path).expect("env file");
    let env: serde_json::Value = serde_json::from_str(&env).expect("env json");
    assert_eq!(env["OPENAI_API_KEY"], serde_json::Value::Null);
    assert_eq!(env["OPENROUTER_API_KEY"], serde_json::Value::Null);
}

#[test]
fn launch_arguments_include_explicit_child_addon_once() {
    let root = temp_root("runner-launch-addon");
    let mut config = test_spawn_config(&root);
    config.runtime_addon = Some(root.join("child-addon.ts"));
    let args = launch_arguments(&config);
    let positions = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.to_string_lossy() == "-e")
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    assert_eq!(positions.len(), 1);
    assert_eq!(args[positions[0] + 1], root.join("child-addon.ts"));
}

#[test]
fn launch_arguments_allowlist_contains_declared_terminal_tool() {
    let root = temp_root("runner-launch-tools");
    let mut config = test_spawn_config(&root);
    config.tools.push("autopilot_submit_atoms".to_owned());
    let args = launch_arguments(&config);
    let tools = args
        .windows(2)
        .find(|pair| pair[0].to_string_lossy() == "--tools")
        .expect("--tools value");
    assert_eq!(tools[1], "read,ls,autopilot_submit_atoms");
}

#[test]
fn runner_rpc_shutdown_closes_stdin_and_reaps_process() {
    let root = temp_root("runner-rpc-shutdown-clean");
    write_fake_pi(&root, &stdin_exit_fake_pi());
    let mut client = spawn_fake_client(&root, 1024 * 1024);
    let shutdown = client.shutdown(Duration::from_secs(5)).expect("shutdown");
    assert!(!shutdown.escalated);
    assert!(shutdown.status.expect("status").success());
}

#[test]
fn runner_rpc_shutdown_requires_the_complete_stderr_reader_result() {
    let root = temp_root("runner-rpc-stderr-complete");
    write_fake_pi(
        &root,
        "#!/usr/bin/env python3\nimport sys\nsys.stderr.write('complete stderr')\nsys.stderr.flush()\n",
    );
    let mut client = spawn_fake_client(&root, 1024 * 1024);
    let shutdown = client.shutdown(Duration::from_secs(5)).expect("shutdown");
    assert_eq!(shutdown.stderr_tail, b"complete stderr");
    assert!(shutdown.status.expect("status").success());
    fs::remove_dir_all(root).expect("remove complete stderr fixture");
}

#[test]
fn runner_rpc_shutdown_rejects_incomplete_stderr_after_process_group_exit() {
    let root = temp_root("runner-rpc-stderr-incomplete");
    write_fake_pi(&root, &escaped_stderr_descendant_fake_pi());
    let mut client = spawn_fake_client(&root, 1024 * 1024);
    let result = client.shutdown(Duration::from_secs(5));
    let retry = client.shutdown(Duration::from_secs(5));
    if result.is_ok() {
        std::thread::sleep(Duration::from_secs(2));
    } else {
        std::thread::sleep(Duration::from_millis(700));
    }
    assert!(matches!(
        result,
        Err(RpcError::Io(detail)) if detail.contains("stderr reader did not complete")
    ));
    assert!(matches!(
        retry,
        Err(RpcError::Io(detail)) if detail.contains("previous terminal wait failed")
    ));
    fs::remove_dir_all(root).expect("remove incomplete stderr fixture");
}

#[test]
fn runner_rpc_shutdown_kills_a_stderr_retaining_descendant_before_success() {
    let root = temp_root("runner-rpc-stderr-descendant");
    let marker = root.join("descendant-survived");
    write_fake_pi(&root, &stderr_descendant_fake_pi(&marker));
    let mut client = spawn_fake_client(&root, 1024 * 1024);
    let shutdown = client.shutdown(Duration::from_secs(5)).expect("shutdown");
    assert!(!shutdown.escalated);
    let status = shutdown.status.expect("status");
    assert!(status.success(), "unexpected child status: {status:?}");
    std::thread::sleep(Duration::from_millis(500));
    match fs::remove_file(&marker) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Ok(()) => panic!("stderr-retaining descendant survived shutdown"),
        Err(error) => panic!("descendant marker cleanup failed: {error}"),
    }
    fs::remove_dir_all(root).expect("remove stderr descendant fixture");
}

#[test]
fn runner_rpc_shutdown_escalates_hung_process() {
    let root = temp_root("runner-rpc-shutdown-hung");
    write_fake_pi(&root, &hung_fake_pi());
    let mut client = spawn_fake_client(&root, 1024 * 1024);
    let shutdown = client
        .shutdown(Duration::from_millis(50))
        .expect("shutdown");
    assert!(shutdown.escalated);
}

#[test]
fn runner_rpc_shutdown_kills_sigterm_ignoring_descendant_after_leader_exit() {
    let root = temp_root("runner-rpc-shutdown-term-descendant");
    let marker = root.join("sigterm-descendant-survived");
    write_fake_pi(&root, &sigterm_descendant_fake_pi(&marker));
    let mut client = spawn_fake_client(&root, 1024 * 1024);
    let shutdown = client
        .shutdown(Duration::from_millis(50))
        .expect("shutdown");
    assert!(shutdown.escalated);
    std::thread::sleep(Duration::from_millis(700));
    match fs::remove_file(&marker) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Ok(()) => panic!("SIGTERM-ignoring descendant survived shutdown"),
        Err(error) => panic!("SIGTERM descendant marker cleanup failed: {error}"),
    }
    fs::remove_dir_all(root).expect("remove SIGTERM descendant fixture");
}

fn test_spawn_config(root: &Path) -> RpcSpawnConfig {
    RpcSpawnConfig::new(
        root.to_path_buf(),
        "openai-codex".to_owned(),
        "gpt-5.5".to_owned(),
        "high".to_owned(),
        "session-123".to_owned(),
        root.join("run-sessions"),
        vec!["read".to_owned(), "ls".to_owned()],
    )
}

fn spawn_fake_client(root: &Path, max_terminal_bytes: usize) -> RpcClient {
    let mut config = test_spawn_config(root);
    config.pi_executable = root.join("pi").into_os_string();
    config.max_terminal_bytes = max_terminal_bytes;
    RpcClient::spawn(config).expect("spawn fake rpc pi")
}

fn volume_fake_pi() -> String {
    let terminal = r#"{"type":"message_end","message":{"role":"assistant","provider":"openai-codex","model":"gpt-5.5","stopReason":"stop","content":[{"type":"text","text":"TERMINAL_OK"}]}}"#;
    format!(
        r#"#!/usr/bin/env python3
import json, math, sys
line = json.dumps({{"type":"message_update","message":{{"content":[{{"type":"text","text":"" + ("x" * (225 * 1024))}}]}},"assistantMessageEvent":{{"type":"text_delta","delta":"x"}}}}, separators=(",",":")) + "\n"
count = math.ceil((548 * 1024 * 1024) / len(line.encode()))
cmd = sys.stdin.readline()
req = json.loads(cmd)
sys.stdout.write(json.dumps({{"id":req["id"],"type":"response","command":req["type"],"success":True}}, separators=(",",":")) + "\n")
sys.stdout.write('{{"type":"agent_start"}}\n')
for index in range(count):
    sys.stdout.write(line)
    if index % 64 == 0:
        sys.stdout.flush()
sys.stdout.write({terminal:?} + "\n")
sys.stdout.write('{{"type":"agent_end","messages":[],"willRetry":false}}\n')
sys.stdout.write('{{"type":"agent_settled"}}\n')
sys.stdout.flush()
for _ in sys.stdin:
    pass
"#
    )
}

fn argv_env_fake_pi(argv_path: &Path, env_path: &Path) -> String {
    format!(
        r#"#!/usr/bin/env python3
import json, os, sys
with open({:?}, "w") as f:
    json.dump({{"args": sys.argv[1:]}}, f)
with open({:?}, "w") as f:
    json.dump({{"OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY"), "OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY")}}, f)
for _ in sys.stdin:
    pass
"#,
        argv_path.display().to_string(),
        env_path.display().to_string()
    )
}

fn escaped_stderr_descendant_fake_pi() -> String {
    r#"#!/usr/bin/env python3
import subprocess, sys
subprocess.Popen(
    [sys.executable, "-c", "import time;time.sleep(1.5)"],
    stdout=subprocess.DEVNULL,
    start_new_session=True,
)
"#
    .to_owned()
}

fn stderr_descendant_fake_pi(marker: &Path) -> String {
    format!(
        r#"#!/usr/bin/env python3
import subprocess, sys
code = 'import pathlib,time;time.sleep(0.2);pathlib.Path({:?}).write_text("survived")'
subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.DEVNULL)
"#,
        marker.display().to_string()
    )
}

fn stdin_exit_fake_pi() -> String {
    r#"#!/usr/bin/env python3
import sys
for _ in sys.stdin:
    pass
"#
    .to_owned()
}

fn sigterm_descendant_fake_pi(marker: &Path) -> String {
    format!(
        r#"#!/usr/bin/env python3
import subprocess, sys, time
code = 'import pathlib,signal,sys,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);time.sleep(0.5);pathlib.Path({:?}).write_text("survived")'
descendant = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE)
if descendant.stdout.readline() != b"ready\\n":
    sys.exit(65)
while True:
    time.sleep(10)
"#,
        marker.display().to_string()
    )
}

fn hung_fake_pi() -> String {
    r#"#!/usr/bin/env python3
import time
while True:
    time.sleep(10)
"#
    .to_owned()
}

fn write_fake_pi(root: &Path, body: &str) {
    let path = root.join("pi");
    fs::write(&path, body).expect("write fake pi");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).expect("chmod");
    }
}

fn temp_root(name: &str) -> PathBuf {
    let parent = std::env::temp_dir();
    let pid = std::process::id();
    loop {
        let nonce = TEMP_ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = parent.join(format!("pi-autopilot-{name}-{pid}-{nonce}"));
        match fs::create_dir(&root) {
            Ok(()) => return fs::canonicalize(&root).expect("canonical temp root"),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("temp root {root:?}: {error}"),
        }
    }
}

struct ChunkedRead {
    data: Vec<u8>,
    position: usize,
    chunk: usize,
}

impl ChunkedRead {
    fn new(data: Vec<u8>, chunk: usize) -> Self {
        Self {
            data,
            position: 0,
            chunk,
        }
    }
}

impl Read for ChunkedRead {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.position >= self.data.len() {
            return Ok(0);
        }
        let n = self
            .chunk
            .min(buf.len())
            .min(self.data.len().saturating_sub(self.position));
        buf[..n].copy_from_slice(&self.data[self.position..self.position + n]);
        self.position += n;
        Ok(n)
    }
}
