/// Decides whether the pre-launch update gate should run.
///
/// Split out as a pure function so the policy is testable without a Tauri app,
/// a network, or a release build.
#[derive(Debug, PartialEq, Eq)]
pub enum GateDecision {
    Run,
    Skip(&'static str),
}

pub fn decide(is_debug: bool, skip_env: Option<&str>) -> GateDecision {
    if is_debug {
        return GateDecision::Skip("debug build");
    }
    if skip_env.is_some_and(|v| !v.is_empty()) {
        return GateDecision::Skip("ALPINE_SKIP_UPDATE_GATE set");
    }
    GateDecision::Run
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_in_release_with_no_env_override() {
        assert_eq!(decide(false, None), GateDecision::Run);
    }

    #[test]
    fn skips_in_debug_builds() {
        // `tauri dev` must not try to install an update over the dev server.
        assert!(matches!(decide(true, None), GateDecision::Skip(_)));
    }

    #[test]
    fn skips_when_env_var_is_set_to_anything_non_empty() {
        assert!(matches!(decide(false, Some("1")), GateDecision::Skip(_)));
        assert!(matches!(decide(false, Some("false")), GateDecision::Skip(_)));
    }

    #[test]
    fn empty_env_var_does_not_skip() {
        // An accidentally-exported empty variable should not silently disable
        // the gate in production.
        assert_eq!(decide(false, Some("")), GateDecision::Run);
    }
}
