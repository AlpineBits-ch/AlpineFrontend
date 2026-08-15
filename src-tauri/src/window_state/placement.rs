//! Turning a remembered geometry plus the displays that exist *now* into a
//! rectangle to open the window at.
//!
//! Pure, and deliberately so: this is where every interesting decision lives,
//! and none of it needs a window, a display or a running app to exercise.

use super::model::{
    LogicalOffset, LogicalSize, MonitorId, PhysPoint, PhysSize, WindowGeometry, WindowMode,
    MAX_SCALE, MIN_SCALE, MIN_VISIBLE_HEIGHT, MIN_VISIBLE_WIDTH,
};

/// A display as it exists right now.
///
/// `work_area_*` excludes the taskbar and any other reserved strip, which is
/// what a window should be placed within. `id` carries the full monitor bounds
/// instead, because that is the stable thing to fingerprint - the work area
/// changes when the taskbar is moved or auto-hidden.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    pub id: MonitorId,
    pub work_area_pos: PhysPoint,
    pub work_area_size: PhysSize,
    pub primary: bool,
}

/// Where to open the window, in physical pixels.
///
/// The main window is `decorations(false)`, so outer and inner extents are the
/// same thing here and no frame allowance is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub position: PhysPoint,
    pub size: PhysSize,
    pub mode: WindowMode,
}

/// Finds the display a remembered geometry belongs to, in descending order of
/// confidence: an exact fingerprint, then the same name, then the same
/// rectangle in the desktop arrangement.
///
/// Names are not guaranteed unique - some drivers report `\\.\DISPLAY1` for
/// two identical panels - so the name pass takes the first match. Being
/// consistent about which one is better than guessing between them, and the
/// clamp in [`resolve`] keeps the result usable either way.
pub fn match_monitor<'a>(
    saved: &MonitorId,
    monitors: &'a [MonitorInfo],
) -> Option<&'a MonitorInfo> {
    // Each pass scans the whole list before the next begins, so a display that
    // matches outright is never shadowed by an earlier partial match.
    monitors
        .iter()
        .find(|m| saved.matches_exactly(&m.id))
        .or_else(|| monitors.iter().find(|m| saved.matches_by_name(&m.id)))
        .or_else(|| monitors.iter().find(|m| saved.matches_by_geometry(&m.id)))
}

/// Resolves the rectangle to open at.
///
/// Returns `None` only when there are no displays at all, in which case the
/// caller should leave the window wherever the platform put it.
///
/// `saved` of `None` - no state, or state that failed validation - produces
/// `default_size` centered on the primary display. That is the same path a
/// corrupt file takes, which is why corruption cannot cost the user a window.
pub fn resolve(
    saved: Option<&WindowGeometry>,
    monitors: &[MonitorInfo],
    default_size: LogicalSize,
    min_size: LogicalSize,
) -> Option<Placement> {
    let primary = monitors.iter().find(|m| m.primary).or(monitors.first())?;

    // `None` for the offset means "centre me": either there is nothing saved,
    // or the display it was saved on no longer exists. Both forfeit the
    // position and keep the size, which is the part the user chose deliberately.
    let (target, wanted, offset, mode) = match saved {
        Some(g) => match match_monitor(&g.monitor, monitors) {
            Some(m) => (m, g.size, Some(g.offset), g.mode),
            None => (primary, g.size, None, g.mode),
        },
        None => (primary, default_size, None, WindowMode::Windowed),
    };

    // `MonitorInfo` is reported by the OS, so unlike the saved geometry it has
    // never been through `is_sane`. A scale of 0 divides through to infinity
    // and reaches the cast to i32 as NaN; a NaN scale makes `f64::clamp` panic
    // outright on `min <= max`. Neither is hypothetical enough to leave open.
    let scale = if target.id.scale.is_finite() && (MIN_SCALE..=MAX_SCALE).contains(&target.id.scale)
    {
        target.id.scale
    } else {
        eprintln!(
            "[window-state] display reported an unusable scale factor ({}), assuming 1.0",
            target.id.scale
        );
        1.0
    };

    // An empty work area is a display that failed to report one, not a display
    // with no room on it. Its full bounds are the better answer.
    let (wa_x, wa_y, wa_w, wa_h) =
        if target.work_area_size.width > 0 && target.work_area_size.height > 0 {
            (
                target.work_area_pos.x as f64,
                target.work_area_pos.y as f64,
                target.work_area_size.width as f64,
                target.work_area_size.height as f64,
            )
        } else {
            (
                target.id.position.x as f64,
                target.id.position.y as f64,
                target.id.size.width as f64,
                target.id.size.height as f64,
            )
        };

    // Fit the window to the display in logical units, where "how big the user
    // wanted it" is meaningful. `min` before `max` so the minimum size wins on
    // a work area too small to hold it - the platform enforces it regardless.
    let width = wanted.width.min(wa_w / scale).max(min_size.width);
    let height = wanted.height.min(wa_h / scale).max(min_size.height);

    let (offset_x, offset_y) = match offset {
        Some(o) => (o.x, o.y),
        None => (
            (wa_w / scale - width) / 2.0,
            (wa_h / scale - height) / 2.0,
        ),
    };

    let size = PhysSize {
        width: (width * scale).round().max(1.0) as u32,
        height: (height * scale).round().max(1.0) as u32,
    };

    // The clamp invariant, applied on every path including an exact match: a
    // state file that was valid when written must still not be able to open the
    // window somewhere unreachable, because the displays can change under it.
    let visible_w = MIN_VISIBLE_WIDTH * scale;
    let visible_h = MIN_VISIBLE_HEIGHT * scale;

    let max_x = wa_x + wa_w - visible_w;
    let min_x = wa_x - (size.width as f64 - visible_w);
    // The top edge is where the custom titlebar lives, so it may never go above
    // the work area - a window dragged up there cannot be recovered by mouse.
    let max_y = wa_y + wa_h - visible_h;
    let min_y = wa_y;

    // `min_x.min(max_x)` guards a work area too small for even the visible
    // sliver, where the lower bound would otherwise exceed the upper one and
    // `clamp` would panic.
    let x = (wa_x + offset_x * scale).clamp(min_x.min(max_x), max_x);
    let y = (wa_y + offset_y * scale).clamp(min_y.min(max_y), max_y);

    Some(Placement {
        position: PhysPoint {
            x: x.round() as i32,
            y: y.round() as i32,
        },
        size,
        mode,
    })
}

/// What the window looked like at one instant, read on the main thread.
///
/// `rect` is `Some` only when the window was plain windowed at the moment of
/// reading. That is the whole safety rule: a rect observed during a maximize or
/// fullscreen transition is never a windowed rect, and must not be recorded as
/// one.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub mode: WindowMode,
    pub monitor: MonitorId,
    /// Origin of the work area of the display the window is currently on.
    pub work_area_pos: PhysPoint,
    pub scale: f64,
    /// Outer position and inner size, physical. `None` unless plain windowed.
    pub rect: Option<(PhysPoint, PhysSize)>,
}

/// Folds an observation into what is already remembered.
///
/// The mode and the display are always taken from the observation - dragging a
/// maximized window to another screen means "the app lives over here now", and
/// the clamp in [`resolve`] re-fits the stored offset on the way back out.
///
/// The windowed rect is only ever taken from an observation that was itself
/// plain windowed. This is what keeps leaving fullscreen from dropping the
/// window at monitor bounds, and what keeps a maximize from overwriting the
/// windowed offset with the maximized origin - on Windows the `Moved` event
/// that accompanies a maximize arrives before the maximized bit is set, so the
/// reading taken there looks windowed and is not.
pub fn commit(
    previous: Option<&WindowGeometry>,
    observation: &Observation,
    default_size: LogicalSize,
) -> WindowGeometry {
    // Same guard as `resolve`: the scale comes from the OS, and dividing by a
    // nonsense one would write NaN into a file that then fails to serialize.
    let scale = if observation.scale.is_finite()
        && (MIN_SCALE..=MAX_SCALE).contains(&observation.scale)
    {
        observation.scale
    } else {
        1.0
    };

    let mut geometry = previous.cloned().unwrap_or(WindowGeometry {
        size: default_size,
        offset: LogicalOffset { x: 0.0, y: 0.0 },
        monitor: observation.monitor.clone(),
        mode: observation.mode,
    });

    geometry.mode = observation.mode;
    geometry.monitor = observation.monitor.clone();

    if let Some((position, size)) = observation.rect {
        // A zero extent is what the platform reports mid-transition and while
        // a window is being torn down. It is never a size the user chose.
        if size.width > 0 && size.height > 0 {
            geometry.size = LogicalSize {
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
            };
            geometry.offset = LogicalOffset {
                x: (position.x - observation.work_area_pos.x) as f64 / scale,
                y: (position.y - observation.work_area_pos.y) as f64 / scale,
            };
        }
    }

    geometry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_state::model::MAX_LOGICAL_EXTENT;

    const MIN: LogicalSize = LogicalSize {
        width: 900.0,
        height: 600.0,
    };
    const DEFAULT: LogicalSize = LogicalSize {
        width: 1200.0,
        height: 800.0,
    };

    /// A 4K display at 150%, with a 60px taskbar. Logical work area: 2560x1400.
    fn hidpi() -> MonitorInfo {
        MonitorInfo {
            id: MonitorId {
                name: Some("\\\\.\\DISPLAY1".into()),
                position: PhysPoint { x: 0, y: 0 },
                size: PhysSize {
                    width: 3840,
                    height: 2160,
                },
                scale: 1.5,
            },
            work_area_pos: PhysPoint { x: 0, y: 0 },
            work_area_size: PhysSize {
                width: 3840,
                height: 2100,
            },
            primary: true,
        }
    }

    /// A 1080p display at 100%, with a 40px taskbar. Logical work area: 1920x1040.
    fn sdr(name: &str, x: i32, primary: bool) -> MonitorInfo {
        MonitorInfo {
            id: MonitorId {
                name: Some(name.into()),
                position: PhysPoint { x, y: 0 },
                size: PhysSize {
                    width: 1920,
                    height: 1080,
                },
                scale: 1.0,
            },
            work_area_pos: PhysPoint { x, y: 0 },
            work_area_size: PhysSize {
                width: 1920,
                height: 1040,
            },
            primary,
        }
    }

    fn saved_on(monitor: &MonitorInfo, offset: LogicalOffset, size: LogicalSize) -> WindowGeometry {
        WindowGeometry {
            size,
            offset,
            monitor: monitor.id.clone(),
            mode: WindowMode::Windowed,
        }
    }

    // -- match_monitor -------------------------------------------------------

    #[test]
    fn matches_the_same_display_untouched() {
        let monitors = [sdr("\\\\.\\DISPLAY2", -1920, false), hidpi()];
        let found = match_monitor(&hidpi().id, &monitors).expect("display is present");
        assert_eq!(found.id, hidpi().id);
    }

    #[test]
    fn matches_the_same_display_after_a_resolution_change() {
        let mut changed = hidpi();
        changed.id.size = PhysSize {
            width: 1920,
            height: 1080,
        };
        changed.id.scale = 1.0;

        let monitors = [changed.clone()];
        let found = match_monitor(&hidpi().id, &monitors).expect("same display by name");
        assert_eq!(found.id.name, changed.id.name);
    }

    /// The name pass must not shadow a display that matches outright.
    #[test]
    fn prefers_an_exact_match_over_an_earlier_name_match() {
        let mut reconfigured = hidpi();
        reconfigured.id.scale = 2.0;
        reconfigured.id.position = PhysPoint { x: -3840, y: 0 };

        let monitors = [reconfigured, hidpi()];
        let found = match_monitor(&hidpi().id, &monitors).expect("exact match exists");
        assert_eq!(found.id.position, PhysPoint { x: 0, y: 0 });
    }

    /// `Monitor::name()` is `None` on some platforms; geometry is all there is.
    #[test]
    fn falls_back_to_geometry_when_the_saved_name_is_absent() {
        let mut nameless = hidpi().id;
        nameless.name = None;

        let monitors = [hidpi()];
        let found = match_monitor(&nameless, &monitors).expect("same rectangle");
        assert_eq!(found.id.name, hidpi().id.name);
    }

    #[test]
    fn finds_nothing_when_the_display_is_gone() {
        assert!(match_monitor(&hidpi().id, &[sdr("\\\\.\\DISPLAY9", 0, true)]).is_none());
    }

    #[test]
    fn finds_nothing_when_there_are_no_displays() {
        assert!(match_monitor(&hidpi().id, &[]).is_none());
    }

    // -- resolve: the happy path ---------------------------------------------

    #[test]
    fn restores_the_remembered_rect_on_the_remembered_display() {
        let saved = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);

        let placed = resolve(Some(&saved), &[hidpi()], DEFAULT, MIN).unwrap();

        // 1200x800 logical at 150% is 1800x1200 physical, 120x60 logical in
        // from the work area origin is 180x90 physical.
        assert_eq!(
            placed,
            Placement {
                position: PhysPoint { x: 180, y: 90 },
                size: PhysSize {
                    width: 1800,
                    height: 1200
                },
                mode: WindowMode::Windowed,
            }
        );
    }

    /// The defect that motivated storing logical units. The same window moved
    /// from a 150% display to a 100% one must stay the size the user chose.
    #[test]
    fn preserves_perceived_size_when_the_scale_changes() {
        let saved = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);
        let mut rescaled = sdr("\\\\.\\DISPLAY1", 0, true);
        rescaled.id.name = hidpi().id.name;

        let placed = resolve(Some(&saved), &[rescaled], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed.size,
            PhysSize {
                width: 1200,
                height: 800
            }
        );
        assert_eq!(placed.position, PhysPoint { x: 120, y: 60 });
    }

    #[test]
    fn restores_onto_a_display_left_of_primary() {
        let left = sdr("\\\\.\\DISPLAY2", -1920, false);
        let saved = saved_on(&left, LogicalOffset { x: 50.0, y: 50.0 }, DEFAULT);

        let placed = resolve(Some(&saved), &[sdr("\\\\.\\DISPLAY1", 0, true), left], DEFAULT, MIN)
            .unwrap();

        assert_eq!(placed.position, PhysPoint { x: -1870, y: 50 });
    }

    #[test]
    fn carries_the_mode_through() {
        for mode in [WindowMode::Maximized, WindowMode::Fullscreen] {
            let mut saved = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);
            saved.mode = mode;
            assert_eq!(resolve(Some(&saved), &[hidpi()], DEFAULT, MIN).unwrap().mode, mode);
        }
    }

    // -- resolve: the display is gone ----------------------------------------

    #[test]
    fn centers_on_primary_keeping_the_size_when_the_display_is_gone() {
        let saved = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);
        let survivor = sdr("\\\\.\\DISPLAY9", 0, true);

        let placed = resolve(Some(&saved), &[survivor], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed.size,
            PhysSize {
                width: 1200,
                height: 800
            },
            "the size the user chose survives losing the display"
        );
        // Centered in a 1920x1040 work area.
        assert_eq!(placed.position, PhysPoint { x: 360, y: 120 });
    }

    #[test]
    fn centers_on_the_primary_display_not_the_first_one() {
        let saved = saved_on(&hidpi(), LogicalOffset { x: 0.0, y: 0.0 }, DEFAULT);
        let monitors = [
            sdr("\\\\.\\DISPLAY8", -1920, false),
            sdr("\\\\.\\DISPLAY9", 0, true),
        ];

        let placed = resolve(Some(&saved), &monitors, DEFAULT, MIN).unwrap();

        assert_eq!(placed.position, PhysPoint { x: 360, y: 120 });
    }

    // -- resolve: no saved state ---------------------------------------------

    #[test]
    fn uses_the_default_size_centered_when_nothing_is_saved() {
        let placed = resolve(None, &[sdr("\\\\.\\DISPLAY1", 0, true)], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed,
            Placement {
                position: PhysPoint { x: 360, y: 120 },
                size: PhysSize {
                    width: 1200,
                    height: 800
                },
                mode: WindowMode::Windowed,
            }
        );
    }

    #[test]
    fn gives_up_when_there_are_no_displays() {
        assert!(resolve(None, &[], DEFAULT, MIN).is_none());
    }

    // -- resolve: the clamp invariant ----------------------------------------

    #[test]
    fn shrinks_a_window_too_large_for_the_display() {
        let target = sdr("\\\\.\\DISPLAY1", 0, true);
        let saved = saved_on(
            &target,
            LogicalOffset { x: 0.0, y: 0.0 },
            LogicalSize {
                width: 3000.0,
                height: 2000.0,
            },
        );

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed.size,
            PhysSize {
                width: 1920,
                height: 1040
            }
        );
    }

    #[test]
    fn never_restores_below_the_minimum_size() {
        let target = sdr("\\\\.\\DISPLAY1", 0, true);
        let saved = saved_on(
            &target,
            LogicalOffset { x: 0.0, y: 0.0 },
            LogicalSize {
                width: 100.0,
                height: 100.0,
            },
        );

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed.size,
            PhysSize {
                width: 900,
                height: 600
            }
        );
    }

    /// `min_inner_size` is a hard constraint the platform will enforce anyway,
    /// so on a work area too small to hold it the minimum wins and the window
    /// overflows. Pretending otherwise would just move the surprise.
    #[test]
    fn the_minimum_size_beats_a_work_area_smaller_than_it() {
        let mut tiny = sdr("\\\\.\\DISPLAY1", 0, true);
        tiny.work_area_size = PhysSize {
            width: 800,
            height: 500,
        };

        let placed = resolve(None, &[tiny], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed.size,
            PhysSize {
                width: 900,
                height: 600
            }
        );
    }

    /// The core safety property: a saved rect that is nowhere near a display
    /// still opens somewhere the user can see and grab.
    #[test]
    fn pulls_a_window_that_would_open_off_the_right_edge_back_into_view() {
        let target = sdr("\\\\.\\DISPLAY1", 0, true);
        let saved = saved_on(&target, LogicalOffset { x: 10000.0, y: 0.0 }, DEFAULT);

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        // At most, the left MIN_VISIBLE_WIDTH of the window stays on screen.
        assert_eq!(placed.position.x, 1920 - MIN_VISIBLE_WIDTH as i32);
    }

    #[test]
    fn pulls_a_window_that_would_open_off_the_left_edge_back_into_view() {
        let target = sdr("\\\\.\\DISPLAY1", 0, true);
        let saved = saved_on(&target, LogicalOffset { x: -10000.0, y: 0.0 }, DEFAULT);

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        // At most, the right MIN_VISIBLE_WIDTH of the window stays on screen.
        assert_eq!(placed.position.x, MIN_VISIBLE_WIDTH as i32 - 1200);
    }

    /// The titlebar is the drag handle, so the top edge may never go above the
    /// work area - a window dragged up there cannot be recovered with a mouse.
    #[test]
    fn never_places_the_titlebar_above_the_work_area() {
        let target = sdr("\\\\.\\DISPLAY1", 0, true);
        let saved = saved_on(&target, LogicalOffset { x: 0.0, y: -500.0 }, DEFAULT);

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        assert_eq!(placed.position.y, 0);
    }

    #[test]
    fn keeps_the_titlebar_visible_at_the_bottom_edge() {
        let target = sdr("\\\\.\\DISPLAY1", 0, true);
        let saved = saved_on(&target, LogicalOffset { x: 0.0, y: 5000.0 }, DEFAULT);

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        assert_eq!(placed.position.y, 1040 - MIN_VISIBLE_HEIGHT as i32);
    }

    /// The clamp runs even when the fingerprint matched exactly, so a file that
    /// was valid when written cannot strand the window after a taskbar move.
    #[test]
    fn clamps_even_on_an_exact_monitor_match() {
        let mut target = sdr("\\\\.\\DISPLAY1", 0, true);
        target.work_area_size = PhysSize {
            width: 1920,
            height: 600,
        };
        let saved = saved_on(&target, LogicalOffset { x: 0.0, y: 900.0 }, DEFAULT);

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        assert_eq!(placed.position.y, 600 - MIN_VISIBLE_HEIGHT as i32);
    }

    // -- resolve: the display itself reports nonsense ------------------------
    //
    // `MonitorInfo` comes from the OS, not from the state file, so
    // `WindowGeometry::is_sane` never sees it. A driver reporting a scale of 0
    // would otherwise divide straight through to infinity and land a NaN in
    // the cast to i32.

    #[test]
    fn survives_a_display_reporting_a_scale_of_zero() {
        let mut broken = sdr("\\\\.\\DISPLAY1", 0, true);
        broken.id.scale = 0.0;

        let placed = resolve(None, &[broken], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed,
            Placement {
                position: PhysPoint { x: 360, y: 120 },
                size: PhysSize {
                    width: 1200,
                    height: 800
                },
                mode: WindowMode::Windowed,
            },
            "a nonsense scale is treated as 1.0 rather than propagated"
        );
    }

    #[test]
    fn survives_a_display_reporting_a_non_finite_scale() {
        let mut broken = sdr("\\\\.\\DISPLAY1", 0, true);
        broken.id.scale = f64::NAN;

        let placed = resolve(None, &[broken], DEFAULT, MIN).unwrap();

        assert_eq!(
            placed.size,
            PhysSize {
                width: 1200,
                height: 800
            }
        );
    }

    /// An empty work area is not a display with no room on it - it is a display
    /// that failed to report one. Fall back to its full bounds.
    #[test]
    fn falls_back_to_full_bounds_when_the_work_area_is_empty() {
        let mut broken = sdr("\\\\.\\DISPLAY1", 0, true);
        broken.work_area_size = PhysSize {
            width: 0,
            height: 0,
        };

        let placed = resolve(None, &[broken], DEFAULT, MIN).unwrap();

        // Centered in the full 1920x1080 bounds rather than in nothing.
        assert_eq!(placed.position, PhysPoint { x: 360, y: 140 });
        assert_eq!(
            placed.size,
            PhysSize {
                width: 1200,
                height: 800
            }
        );
    }

    // -- commit --------------------------------------------------------------

    fn observation(mode: WindowMode, rect: Option<(PhysPoint, PhysSize)>) -> Observation {
        Observation {
            mode,
            monitor: hidpi().id,
            work_area_pos: PhysPoint { x: 0, y: 0 },
            scale: 1.5,
            rect,
        }
    }

    #[test]
    fn commit_records_a_windowed_rect_in_logical_units() {
        let obs = observation(
            WindowMode::Windowed,
            Some((
                PhysPoint { x: 180, y: 90 },
                PhysSize {
                    width: 1800,
                    height: 1200,
                },
            )),
        );

        let committed = commit(None, &obs, DEFAULT);

        assert_eq!(committed.size, DEFAULT, "1800x1200 at 150% is 1200x800");
        assert_eq!(committed.offset, LogicalOffset { x: 120.0, y: 60.0 });
        assert_eq!(committed.mode, WindowMode::Windowed);
    }

    #[test]
    fn commit_measures_the_offset_from_the_work_area_not_the_screen() {
        let mut obs = observation(
            WindowMode::Windowed,
            Some((
                PhysPoint { x: -1870, y: 100 },
                PhysSize {
                    width: 1200,
                    height: 800,
                },
            )),
        );
        obs.scale = 1.0;
        obs.work_area_pos = PhysPoint { x: -1920, y: 40 };

        let committed = commit(None, &obs, DEFAULT);

        assert_eq!(committed.offset, LogicalOffset { x: 50.0, y: 60.0 });
    }

    /// The crux. A maximize must not overwrite the rect the user will get back
    /// when they un-maximize.
    #[test]
    fn commit_keeps_the_windowed_rect_when_the_window_is_maximized() {
        let previous = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);

        let committed = commit(Some(&previous), &observation(WindowMode::Maximized, None), DEFAULT);

        assert_eq!(committed.mode, WindowMode::Maximized);
        assert_eq!(committed.size, previous.size);
        assert_eq!(committed.offset, previous.offset);
    }

    /// The same rule is what makes leaving fullscreen land somewhere sane
    /// rather than at monitor bounds.
    #[test]
    fn commit_keeps_the_windowed_rect_when_the_window_is_fullscreen() {
        let previous = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);

        let committed = commit(
            Some(&previous),
            &observation(WindowMode::Fullscreen, None),
            DEFAULT,
        );

        assert_eq!(committed.mode, WindowMode::Fullscreen);
        assert_eq!(committed.size, previous.size);
        assert_eq!(committed.offset, previous.offset);
    }

    /// Dragging a maximized window to another screen is a deliberate move, and
    /// is remembered even though the rect is not.
    #[test]
    fn commit_updates_the_display_even_when_not_windowed() {
        let previous = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);
        let elsewhere = sdr("\\\\.\\DISPLAY7", -1920, false);
        let mut obs = observation(WindowMode::Maximized, None);
        obs.monitor = elsewhere.id.clone();

        let committed = commit(Some(&previous), &obs, DEFAULT);

        assert_eq!(committed.monitor, elsewhere.id);
        assert_eq!(committed.offset, previous.offset, "the rect is left alone");
    }

    /// Maximizing on the very first launch, before any windowed rect has been
    /// observed, must still produce something restorable.
    #[test]
    fn commit_seeds_a_default_rect_when_there_is_nothing_previous() {
        let committed = commit(None, &observation(WindowMode::Maximized, None), DEFAULT);

        assert_eq!(committed.mode, WindowMode::Maximized);
        assert_eq!(committed.size, DEFAULT);
        assert!(committed.is_sane());
    }

    /// Whatever comes out of `commit` is written straight to disk, so it has to
    /// survive `is_sane` or `serialize_state` will silently drop it.
    #[test]
    fn commit_never_produces_an_entry_that_would_be_dropped_on_write() {
        let mut obs = observation(
            WindowMode::Windowed,
            Some((
                PhysPoint { x: 0, y: 0 },
                PhysSize {
                    width: 1,
                    height: 1,
                },
            )),
        );
        obs.scale = 0.0;

        let committed = commit(None, &obs, DEFAULT);

        assert!(
            committed.is_sane(),
            "a nonsense scale must not produce an unwritable entry"
        );
    }

    #[test]
    fn commit_ignores_a_zero_sized_rect() {
        let previous = saved_on(&hidpi(), LogicalOffset { x: 120.0, y: 60.0 }, DEFAULT);
        let obs = observation(
            WindowMode::Windowed,
            Some((
                PhysPoint { x: 0, y: 0 },
                PhysSize {
                    width: 0,
                    height: 0,
                },
            )),
        );

        let committed = commit(Some(&previous), &obs, DEFAULT);

        assert_eq!(
            committed.size, previous.size,
            "a zero-sized window is a transient platform reading, not a size"
        );
    }

    #[test]
    fn tolerates_an_offset_at_the_extreme_of_the_sane_range() {
        let target = sdr("\\\\.\\DISPLAY1", 0, true);
        let saved = saved_on(
            &target,
            LogicalOffset {
                x: MAX_LOGICAL_EXTENT,
                y: MAX_LOGICAL_EXTENT,
            },
            DEFAULT,
        );

        let placed = resolve(Some(&saved), &[target], DEFAULT, MIN).unwrap();

        assert_eq!(placed.position.x, 1920 - MIN_VISIBLE_WIDTH as i32);
        assert_eq!(placed.position.y, 1040 - MIN_VISIBLE_HEIGHT as i32);
    }
}
