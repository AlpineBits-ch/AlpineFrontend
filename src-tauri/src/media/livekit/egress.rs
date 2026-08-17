//! Which local addresses can actually reach the SFU, and gathering only on those.
//!
//! # The bug this exists for
//!
//! `webrtc-rs` gathers a host candidate on **every** local interface it can enumerate. A VPN tunnel
//! adapter is a local interface, and a tunnel that cannot carry our media to the SFU still produces
//! a candidate that looks exactly as good as a working one in the offer.
//!
//! Measured on a NordLynx (NordVPN's WireGuard) tunnel on 2026-08-17. With the adapter up, the
//! publisher connection sat at `connecting` for the full ten seconds on seven consecutive joins and
//! the SFU independently gave up with `LeaveRequest { reason: ConnectionTimeout }`. Disabling the
//! adapter fixed it outright. Nothing above the transport noticed: signalling rides the OS's own
//! route rather than a per-interface bind, so the WebSocket, the join, the subscriber offer and the
//! track publication were all healthy while no media could cross.
//!
//! # The rule
//!
//! **Gather only on the address the OS itself would send to the SFU from.**
//!
//! `connect` on a UDP socket transmits nothing. It asks the routing table the same question the
//! kernel asks on every unbound send, and `local_addr` is the answer. That is exactly the selection
//! an ordinary socket makes - the one demonstrably able to reach the SFU on the machine above,
//! while the explicit per-interface binds could not.
//!
//! # Why not a list of adapter names
//!
//! Naming NordLynx would fix one machine and leave the next tunnel - Hyper-V, WSL, Docker,
//! Tailscale, the next VPN vendor - to be discovered by a user with a broken call and a log that
//! says nothing. Asking the routing table is self-maintaining and drops all of them for the same
//! reason at once.
//!
//! # The route is not fixed for the life of a call
//!
//! A tunnel can come up or go down mid-call, and Wi-Fi can hand over to Ethernet. So the allowed
//! set lives behind a lock that the filter closure reads on every candidate rather than being baked
//! into it: [`Route::refresh`] re-asks the routing table, and the next gathering pass - an ICE
//! restart - picks up the new answer without rebuilding the peer connection. See
//! `room::Room::restart_ice`.
//!
//! # Failing open
//!
//! An empty allowed set permits **everything**, and every path here falls back to one. A filter
//! that matched nothing would produce a connection with no host candidates at all, which is both a
//! worse failure than the one this prevents and a much harder one to read. Narrowing is an
//! optimisation over the status quo and is treated as one - including when a refresh mid-call finds
//! no route at all, where gathering on every interface is the best remaining guess.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::{Arc, RwLock};

use webrtc::api::setting_engine::SettingEngine;

/// The addresses gathering is allowed on, re-resolvable for the life of a connection.
///
/// Cheap to clone; every clone shares the one allowed set.
#[derive(Clone)]
pub struct Route {
    host: String,
    port: u16,
    /// Empty means "no opinion", which the filter reads as permitting everything.
    allowed: Arc<RwLock<Vec<IpAddr>>>,
}

impl Route {
    /// Resolve the route to `url`'s host, or `None` if the URL yields no host to route to.
    pub fn to_url(url: &str) -> Option<Self> {
        let (host, port) = host_and_port(url)?;
        let allowed = routable_addresses(&host, port);
        Some(Self {
            host,
            port,
            allowed: Arc::new(RwLock::new(allowed)),
        })
    }

    /// The addresses currently permitted. Empty means everything is.
    pub fn allowed(&self) -> Vec<IpAddr> {
        self.allowed.read().map(|a| a.clone()).unwrap_or_default()
    }

    /// Re-ask the routing table. Returns whether the answer changed.
    ///
    /// Called before an ICE restart, which is the only moment a new answer can take effect: the
    /// filter is consulted during gathering, and gathering only happens again on a restart.
    pub fn refresh(&self) -> bool {
        let fresh = routable_addresses(&self.host, self.port);
        let Ok(mut allowed) = self.allowed.write() else {
            return false;
        };
        if *allowed == fresh {
            return false;
        }
        eprintln!(
            "[livekit] the route to {} changed: {} -> {}",
            self.host,
            render(&allowed),
            render(&fresh)
        );
        *allowed = fresh;
        true
    }

    /// Whether gathering may use `ip`.
    ///
    /// The whole filtering rule, kept as a method because `SettingEngine`'s filter field is private
    /// to `webrtc` and a closure installed on one cannot be read back out to test.
    pub fn permits(&self, ip: IpAddr) -> bool {
        match self.allowed.read() {
            // Empty is "no opinion", not "nothing allowed". See the module docs on failing open.
            // A poisoned lock takes the same branch, for the same reason.
            Ok(allowed) => allowed.is_empty() || allowed.contains(&ip),
            Err(_) => true,
        }
    }

    /// A `SettingEngine` whose gathering is confined to this route.
    pub fn settings(&self) -> SettingEngine {
        let mut settings = SettingEngine::default();
        let route = self.clone();
        settings.set_ip_filter(Box::new(move |ip| route.permits(ip)));
        settings
    }

    /// What this route is, for the log. Its absence is a diagnosis, so it is stated at join.
    pub fn describe(&self) -> String {
        let allowed = self.allowed();
        if allowed.is_empty() {
            format!("no route to {}; gathering on every interface", self.host)
        } else {
            format!("gathering on {} - the route to {}", render(&allowed), self.host)
        }
    }
}

fn render(addresses: &[IpAddr]) -> String {
    if addresses.is_empty() {
        return "every interface".to_string();
    }
    addresses
        .iter()
        .map(|ip| ip.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The local addresses the OS would send to `host` from, one per address family it resolves to.
///
/// Both families are kept when both resolve: an SFU reachable over v4 and v6 is reachable over
/// either, and dropping one would narrow gathering further than the routing table justifies.
pub fn routable_addresses(host: &str, port: u16) -> Vec<IpAddr> {
    let Ok(targets) = (host, port).to_socket_addrs() else {
        return Vec::new();
    };

    let mut found: Vec<IpAddr> = Vec::new();
    let (mut seen_v4, mut seen_v6) = (false, false);
    for target in targets {
        // One probe per family is enough. Every address for a host sits behind the same route in
        // any deployment this client meets, and probing each would multiply syscalls for an answer
        // that cannot differ.
        match target {
            SocketAddr::V4(_) if seen_v4 => continue,
            SocketAddr::V6(_) if seen_v6 => continue,
            SocketAddr::V4(_) => seen_v4 = true,
            SocketAddr::V6(_) => seen_v6 = true,
        }
        if let Some(local) = egress_address(target) {
            if !found.contains(&local) {
                found.push(local);
            }
        }
    }
    found
}

/// The local address the OS would send to `target` from, or `None` if it would not.
///
/// **Sends nothing.** `connect` on a UDP socket only fixes the peer and resolves the route, which
/// is the whole reason this can be asked at join time without a round trip to anywhere.
pub fn egress_address(target: SocketAddr) -> Option<IpAddr> {
    let bind: SocketAddr = match target {
        SocketAddr::V4(_) => ([0, 0, 0, 0], 0).into(),
        SocketAddr::V6(_) => ([0u16; 8], 0).into(),
    };
    let socket = UdpSocket::bind(bind).ok()?;
    socket.connect(target).ok()?;
    let local = socket.local_addr().ok()?.ip();

    // An unspecified address means the OS declined to choose, which is not an answer that can be
    // filtered on - `0.0.0.0` matches no candidate and would gather nothing.
    if local.is_unspecified() {
        return None;
    }
    Some(local)
}

/// Pull the host and port out of a `ws://`/`wss://` URL.
///
/// Deliberately small rather than a URL crate: the input is a LiveKit connection URL handed to us
/// by our own backend, and the only failure that matters is one this returns `None` for, which
/// fails open.
fn host_and_port(url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let default_port = match scheme {
        "wss" | "https" => 443,
        "ws" | "http" => 80,
        _ => return None,
    };

    // Authority only: drop the path, query and fragment, then any userinfo in front of it.
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    if authority.is_empty() {
        return None;
    }

    // An IPv6 literal is bracketed, and its colons are not port separators.
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => default_port,
        };
        return Some((host.to_string(), port));
    }

    match authority.split_once(':') {
        Some((host, port)) => Some((host.to_string(), port.parse().ok()?)),
        None => Some((authority.to_string(), default_port)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_wss_url_takes_the_default_port() {
        // The exact shape the backend hands us, and the one the NordLynx report came from.
        assert_eq!(
            host_and_port("wss://sfu-fsn1.venta.gg"),
            Some(("sfu-fsn1.venta.gg".to_string(), 443))
        );
    }

    #[test]
    fn an_explicit_port_wins_over_the_default() {
        assert_eq!(
            host_and_port("ws://127.0.0.1:7880"),
            Some(("127.0.0.1".to_string(), 7880))
        );
    }

    #[test]
    fn a_path_and_query_are_not_part_of_the_host() {
        assert_eq!(
            host_and_port("wss://sfu.example.com/rtc?access_token=abc"),
            Some(("sfu.example.com".to_string(), 443))
        );
    }

    #[test]
    fn an_ipv6_literal_keeps_its_colons() {
        // The bracket rule is the whole reason this is not a `split(':')`.
        assert_eq!(
            host_and_port("wss://[2a01:4f8::1]:7880"),
            Some(("2a01:4f8::1".to_string(), 7880))
        );
        assert_eq!(
            host_and_port("wss://[2a01:4f8::1]"),
            Some(("2a01:4f8::1".to_string(), 443))
        );
    }

    #[test]
    fn an_unknown_scheme_fails_open_rather_than_guessing_a_port() {
        assert_eq!(host_and_port("sfu-fsn1.venta.gg"), None);
        assert_eq!(host_and_port("ftp://sfu-fsn1.venta.gg"), None);
    }

    #[test]
    fn the_route_to_a_public_address_is_a_real_local_address() {
        // No traffic leaves the machine: this is the routing table being asked a question. It holds
        // on a disconnected machine too, where the answer is simply `None`.
        let target: SocketAddr = ([1, 1, 1, 1], 443).into();
        if let Some(local) = egress_address(target) {
            assert!(!local.is_unspecified(), "an unspecified address is not a route");
            assert!(!local.is_multicast(), "got {local}");
        }
    }

    /// What this machine would gather on, against the real SFU.
    ///
    /// Ignored because the answer is a property of whoever runs it, not of the code - but it is the
    /// only way to see the rule applied to a real interface set, and the machine this was written
    /// on has the exact pathology it exists for: a WSL adapter on 172.21.96.1 that `scripts/
    /// stun-probe.mjs` reports `ENETUNREACH` for. A correct run names the routable address and not
    /// that one.
    ///
    ///   cargo test --lib egress::tests::report -- --ignored --nocapture
    #[test]
    #[ignore = "reports this machine's routing, which is not an assertion"]
    fn report_what_this_machine_would_gather_on() {
        use std::net::UdpSocket;

        let route = Route::to_url("wss://sfu-fsn1.venta.gg").expect("a host");
        println!("PROBE {}", route.describe());

        // Every local IPv4 address, and whether the filter keeps it. The interesting line is any
        // address printed as `dropped`.
        for target in ("sfu-fsn1.venta.gg", 443).to_socket_addrs().expect("resolve") {
            println!("PROBE resolves to {target}");
        }
        let probe = UdpSocket::bind("0.0.0.0:0").expect("bind");
        println!("PROBE unbound local address: {:?}", probe.local_addr());
    }

    #[test]
    fn an_empty_allowed_set_permits_everything() {
        // The failing-open rule, asserted rather than trusted. This is the branch that runs on a
        // machine with no route to the SFU, and getting it backwards would take voice from
        // "degraded on a VPN" to "impossible for everyone".
        let route = Route {
            host: "sfu.example.com".to_string(),
            port: 443,
            allowed: Arc::new(RwLock::new(Vec::new())),
        };
        assert!(route.permits(IpAddr::from([10, 5, 0, 2])), "an empty set must not exclude");
        assert!(route.permits(IpAddr::from([192, 168, 1, 42])));
    }

    #[test]
    fn a_populated_allowed_set_excludes_everything_else() {
        // The NordLynx case: 192.168.1.42 routes to the SFU, the 10.5.0.2 tunnel does not, and the
        // tunnel's host candidate is the one that must never reach the offer.
        let route = Route {
            host: "sfu.example.com".to_string(),
            port: 443,
            allowed: Arc::new(RwLock::new(vec![IpAddr::from([192, 168, 1, 42])])),
        };
        assert!(route.permits(IpAddr::from([192, 168, 1, 42])), "the routed address is kept");
        assert!(!route.permits(IpAddr::from([10, 5, 0, 2])), "the tunnel address is dropped");
    }

    #[test]
    fn the_filter_follows_a_refresh_rather_than_the_set_it_was_built_with() {
        // What makes a mid-call adapter change recoverable: the closure reads the shared set on
        // every candidate, so an ICE restart gathers on the new route without a new connection.
        let route = Route {
            host: "sfu.example.com".to_string(),
            port: 443,
            allowed: Arc::new(RwLock::new(vec![IpAddr::from([192, 168, 1, 42])])),
        };
        // Read through a clone, which is what the installed closure holds.
        let filter = route.clone();
        assert!(!filter.permits(IpAddr::from([10, 5, 0, 2])));

        *route.allowed.write().unwrap() = vec![IpAddr::from([10, 5, 0, 2])];
        assert!(
            filter.permits(IpAddr::from([10, 5, 0, 2])),
            "the filter must see the new route"
        );
        assert!(
            !filter.permits(IpAddr::from([192, 168, 1, 42])),
            "and drop the old one"
        );
    }
}
