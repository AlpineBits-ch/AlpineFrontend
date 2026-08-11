//! That the wasm surface takes the same argument objects the Tauri surface does.
//!
//! <p><b>Why this exists.</b> `mls.rs` already has
//! `the_tauri_argument_names_match_the_typescript_call_sites`, which is there because C2 -
//! `rewrap_master_key` invoked with three of its five arguments - failed 100% of the time and was
//! invisible to a green suite in two languages. The wasm wrappers introduce a *third* copy of every
//! argument object, in the `Args` structs they deserialize into, and until now nothing compared them to
//! anything: they were checked once, by hand, by a throwaway script.</p>
//!
//! <p>The failure this prevents is the same shape and quieter. `MlsEngine.call(command, args)` passes
//! one object to whichever host is present, so a wasm `Args` field that is renamed, dropped, or made
//! required does not break the desktop, does not break the type-checker, and does not break any
//! TypeScript test - it produces `InvalidArguments` in a browser only, on one command, at runtime. Both
//! the names and the *optionality* are asserted, because "may be omitted" is part of the contract: the
//! desktop deserializes an absent `Option<T>` as `None`, and a wasm field that is `Option<T>` without
//! `#[serde(default)]` rejects the whole object instead - which is the same class of failure with an
//! even smaller footprint.</p>
//!
//! <p>Text parsing rather than reflection, deliberately, exactly like its sibling: the `Args` structs
//! are private types declared inside function bodies, and the `#[tauri::command]` wrappers do not exist
//! on this target at all. A macro-level check would need both hosts compiled at once, which is the
//! thing that cannot happen.</p>

use std::collections::BTreeMap;

/// One argument: whether it may be omitted, and whether the wasm side actually allows that.
#[derive(Debug, PartialEq, Eq)]
struct Arg {
    optional: bool,
    /// `#[serde(default)]` is present. Only meaningful on the wasm side.
    defaulted: bool,
}

type Signature = BTreeMap<String, Arg>;

/// The two commands deliberately not exposed to wasm, and why.
///
/// `mls_current_state_dir` reports a filesystem path and there is no filesystem; `device_cert_verify`
/// has no TypeScript caller on any host. Both are named in `wasm.rs`'s header. Listed here so that
/// *removing* an export - which is how a command silently stops working in a browser - fails this test
/// rather than passing quietly.
const NOT_EXPOSED_TO_WASM: [&str; 2] = ["mls_current_state_dir", "device_cert_verify"];

/// Every command exposed to wasm. Pinned so a lost export is a failure, not a smaller number.
const WASM_COMMAND_COUNT: usize = 36;

#[test]
fn the_wasm_argument_names_match_the_tauri_commands() {
    let tauri = tauri_signatures();
    let wasm = wasm_signatures();

    assert_eq!(
        wasm.len(),
        WASM_COMMAND_COUNT,
        "wasm.rs exports {} commands, expected {WASM_COMMAND_COUNT}. A lost export is a \
         'command not found' in the browser only; a gained one needs a line here and in this \
         crate's header.",
        wasm.len(),
    );
    assert!(
        tauri.len() > WASM_COMMAND_COUNT,
        "found only {} #[tauri::command]s across the three modules, which means the parser stopped \
         matching and every comparison below is vacuous",
        tauri.len(),
    );

    let mut problems: Vec<String> = Vec::new();

    for (command, fields) in &wasm {
        let Some(expected) = tauri.get(command) else {
            problems.push(format!(
                "`{command}` is exported to wasm but is not a #[tauri::command]. The wasm name must \
                 be the Tauri command name verbatim - `MlsEngine.call` looks it up with no \
                 translation - so this is a browser-only 'command not found'."
            ));
            continue;
        };

        let mine: Vec<&String> = fields.keys().collect();
        let theirs: Vec<&String> = expected.keys().collect();
        if mine != theirs {
            problems.push(format!(
                "`{command}` takes {theirs:?} over IPC and {mine:?} in its wasm `Args`. One object is \
                 passed to whichever host is present, so a difference here fails on one host only, at \
                 runtime, with `InvalidArguments`."
            ));
            continue;
        }

        for (name, arg) in fields {
            let expected_arg = &expected[name];
            if arg.optional != expected_arg.optional {
                problems.push(format!(
                    "`{command}.{name}` is {} over IPC and {} in its wasm `Args`. Whether an argument \
                     may be omitted is part of the contract: `CredentialKind` not being optional is \
                     precisely what made C2 fail every call.",
                    optionality(expected_arg.optional),
                    optionality(arg.optional),
                ));
            }
            if arg.optional && !arg.defaulted {
                problems.push(format!(
                    "`{command}.{name}` is `Option<..>` in its wasm `Args` but has no \
                     `#[serde(default)]`, so serde requires the key to be present. Tauri deserializes \
                     an absent optional as `None`; without this the same call fails in a browser only."
                ));
            }
        }
    }

    for command in tauri.keys() {
        if wasm.contains_key(command) || NOT_EXPOSED_TO_WASM.contains(&command.as_str()) {
            continue;
        }
        problems.push(format!(
            "`{command}` is a #[tauri::command] with no wasm wrapper. Either add one, or add it to \
             NOT_EXPOSED_TO_WASM here *and* to the 'what is deliberately not exposed' list in \
             wasm.rs - an unexplained gap is a feature that silently does not exist on the web."
        ));
    }

    for command in NOT_EXPOSED_TO_WASM {
        assert!(
            tauri.contains_key(command),
            "NOT_EXPOSED_TO_WASM names `{command}`, which is no longer a #[tauri::command]. Remove it \
             here, or the exemption hides a real gap the next time that name comes back."
        );
    }

    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}

/// The mechanism, verified against a fixture. Without this the test above could pass by finding nothing.
#[test]
fn the_argument_comparison_discriminates() {
    let tauri = parse_tauri(
        "#[tauri::command]\npub fn c(state: tauri::State<X>, group_id_b64: String, \
         message_id: Option<String>) -> Result<(), String> {}\n",
    );
    let matching = parse_wasm(
        "#[wasm_bindgen(js_name = c)]\npub fn c(args_json: &str) -> Result<String, JsValue> {\n\
         struct Args {\n group_id_b64: String,\n #[serde(default)]\n message_id: Option<String>,\n}\n}\n",
    );

    // Tauri's injected `State` never travels over IPC, so it must not be expected of the wasm side.
    assert_eq!(tauri["c"].keys().collect::<Vec<_>>(), vec!["groupIdB64", "messageId"]);
    assert_eq!(tauri["c"].keys().collect::<Vec<_>>(), matching["c"].keys().collect::<Vec<_>>());
    assert!(matching["c"]["messageId"].optional && matching["c"]["messageId"].defaulted);

    // A renamed field is visible.
    let renamed = parse_wasm(
        "#[wasm_bindgen(js_name = c)]\npub fn c(a: &str) -> Result<String, JsValue> {\n\
         struct Args {\n group_id: String,\n #[serde(default)]\n message_id: Option<String>,\n}\n}\n",
    );
    assert_ne!(renamed["c"].keys().collect::<Vec<_>>(), tauri["c"].keys().collect::<Vec<_>>());

    // So is an optional field that serde would nevertheless demand.
    let undefaulted = parse_wasm(
        "#[wasm_bindgen(js_name = c)]\npub fn c(a: &str) -> Result<String, JsValue> {\n\
         struct Args {\n group_id_b64: String,\n message_id: Option<String>,\n}\n}\n",
    );
    assert!(undefaulted["c"]["messageId"].optional && !undefaulted["c"]["messageId"].defaulted);

    // A command with no arguments yields an empty set rather than being skipped, so one that later
    // gains a required argument is compared rather than ignored.
    let bare = parse_wasm(
        "#[wasm_bindgen(js_name = mls_clear_storage)]\npub fn mls_clear_storage() -> \
         Result<String, JsValue> {\n let mut mls = lock()?;\n}\n",
    );
    assert!(bare["mls_clear_storage"].is_empty());
}

fn optionality(optional: bool) -> &'static str {
    if optional { "optional" } else { "required" }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

fn tauri_signatures() -> BTreeMap<String, Signature> {
    let mut all = BTreeMap::new();
    for source in [
        include_str!("mls.rs"),
        include_str!("crypto.rs"),
        include_str!("device_cert.rs"),
    ] {
        all.extend(parse_tauri(source));
    }
    all
}

fn wasm_signatures() -> BTreeMap<String, Signature> {
    parse_wasm(include_str!("wasm.rs"))
}

/// `#[tauri::command] pub fn name(..)` signatures, in `camelCase`, minus what Tauri injects itself.
///
/// `#[cfg_attr(feature = "tauri", tauri::command)]` is normalised first: `crypto.rs`'s commands *are*
/// the implementations, so they cannot be `#[cfg]`-ed out without deleting the master-key API from the
/// wasm build, and they therefore carry the other spelling.
fn parse_tauri(source: &str) -> BTreeMap<String, Signature> {
    let normalized = source.replace(
        "#[cfg_attr(feature = \"tauri\", tauri::command)]",
        "#[tauri::command]",
    );

    let mut out = BTreeMap::new();
    for rest in normalized.split("#[tauri::command]").skip(1) {
        // The declaration must follow the marker *immediately*, allowing only further attributes and
        // doc comments in between. Searching further ahead instead is not a small difference: the
        // marker also appears as a string literal inside `mls.rs`'s own tests, and from there the next
        // `pub fn` is an engine function - so a lenient parser reported `load_signing_key` and two
        // fragments of a Rust expression as commands with no wasm wrapper.
        let Some(decl) = declaration_after(rest) else { continue };
        let Some(open) = decl.find('(') else { continue };
        let Some(close) = matching(decl, open, b'(', b')') else { continue };

        let mut args = Signature::new();
        for param in top_level(&decl[open + 1..close]) {
            let Some((ident, ty)) = param.split_once(':') else { continue };
            let ty = ty.trim();
            // Injected by Tauri, never sent by a caller.
            if ty.contains("State<") || ty.contains("AppHandle") || ty.contains("Window") {
                continue;
            }
            args.insert(
                camel(ident.trim()),
                Arg {optional: ty.starts_with("Option<"), defaulted: true},
            );
        }
        out.insert(decl[..open].trim().to_string(), args);
    }
    out
}

/// Every `#[wasm_bindgen(js_name = ..)]` wrapper's `Args` fields, in `camelCase`.
///
/// The `js_name` is what TypeScript addresses, so it - not the Rust function name - is the key. They are
/// the same today and `generate_mls_key_packages` is the reminder of why that is not guaranteed: it is
/// the one command in the surface without the `mls_` prefix.
fn parse_wasm(source: &str) -> BTreeMap<String, Signature> {
    const MARKER: &str = "#[wasm_bindgen(js_name = ";

    let mut out = BTreeMap::new();
    for block in source.split(MARKER).skip(1) {
        let Some(end) = block.find(')') else { continue };
        let command = block[..end].trim().to_string();

        // Only this wrapper's body: the next marker begins the next one.
        let body = match block.find(MARKER) {
            Some(next) => &block[..next],
            None => block,
        };

        let mut args = Signature::new();
        if let Some(open) = body.find("struct Args {") {
            let brace = open + "struct Args ".len();
            if let Some(close) = matching(body, brace, b'{', b'}') {
                args = parse_fields(&body[brace + 1..close]);
            }
        }
        out.insert(command, args);
    }
    out
}

/// Field declarations of one struct body, with the attributes that precede each one.
fn parse_fields(body: &str) -> Signature {
    let mut out = Signature::new();
    let mut attrs = String::new();

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#[") {
            attrs.push_str(line);
            continue;
        }
        if line.starts_with("//") {
            continue;
        }
        let Some((ident, ty)) = line.split_once(':') else {
            attrs.clear();
            continue;
        };
        let ty = ty.trim().trim_end_matches(',').trim();
        out.insert(
            camel(ident.trim()),
            Arg {
                optional: ty.starts_with("Option<"),
                defaulted: attrs.contains("serde(default)"),
            },
        );
        attrs.clear();
    }
    out
}

/// The `pub fn` declaration that follows an attribute, or `None` if something else does.
///
/// Skips further attributes and doc comments only, so the returned slice always starts at a function
/// name. Anything else - the middle of an expression, a string literal that happens to contain the
/// marker - is not a command and is refused rather than searched past.
fn declaration_after(rest: &str) -> Option<&str> {
    let mut text = rest.trim_start();

    loop {
        if let Some(after) = text.strip_prefix("pub fn ") {
            return Some(after);
        }
        if text.starts_with("#[") {
            let end = matching(text, 0, b'[', b']')?;
            text = text[end + 1..].trim_start();
            continue;
        }
        if text.starts_with("//") {
            let end = text.find('\n')?;
            text = text[end + 1..].trim_start();
            continue;
        }
        return None;
    }
}

fn matching(text: &str, from: usize, open: u8, close: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    let start = (from..bytes.len()).find(|&i| bytes[i] == open)?;
    let mut depth = 0usize;
    for (i, byte) in bytes.iter().enumerate().skip(start) {
        if *byte == open {
            depth += 1;
        } else if *byte == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// Splits on commas outside `<>`, `()` and `[]` - `HashMap<String, Value>` must not be torn in half.
fn top_level(list: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();

    for c in list.chars() {
        match c {
            '<' | '(' | '[' => {
                depth += 1;
                current.push(c);
            }
            '>' | ')' | ']' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                if !current.trim().is_empty() {
                    out.push(current.trim().to_string());
                }
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

fn camel(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper_next = false;
    for c in snake.chars() {
        if c == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}
