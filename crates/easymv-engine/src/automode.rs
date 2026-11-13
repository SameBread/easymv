//! Automatic mode (§7): deterministic routing from project metadata.
//!
//! Hard constraint: this module only emits connections to the property
//! registry (transform / color / filter properties). Internal animation timing
//! is not part of the registry, so it cannot be targeted by construction.

use crate::project::*;

/// Labels treated as melodic (rule 6). Matched case-insensitively against the
/// stem id and label.
pub const MELODIC_LABELS: [&str; 5] = ["violin", "cello", "flute", "voice", "lead"];

/// Auto-mode blur range in pixels.
///
/// NOTE: the design doc lists `outMax: 0.5` for rule 4, but `blur` is specified
/// in pixels (0..200), so 0.5 px would be visually inert. We use a perceptible
/// range instead; change here if 0.5 was intended literally.
pub const AUTO_BLUR_MAX_PX: f32 = 24.0;

#[allow(clippy::too_many_arguments)]
fn conn(
    source: &str,
    feature: &str,
    element: &str,
    property: &str,
    curve: Curve,
    out_min: f32,
    out_max: f32,
    combine: Combine,
    attack_ms: f32,
    release_ms: f32,
) -> Connection {
    Connection {
        source: source.into(),
        feature: feature.into(),
        element: element.into(),
        property: property.into(),
        curve,
        out_min,
        out_max,
        combine,
        attack_ms,
        release_ms,
        threshold: None,
        origin: Origin::Auto,
    }
}

fn is_melodic(s: &StemDef) -> bool {
    let id = s.id.to_lowercase();
    let label = s.label.as_deref().unwrap_or("").to_lowercase();
    MELODIC_LABELS.iter().any(|m| id.contains(m) || label.contains(m))
}

/// Primary element: highest non-negative z-index, first in array on ties.
pub fn primary_element(p: &Project) -> Option<&ElementDef> {
    let mut best: Option<&ElementDef> = None;
    for e in &p.elements {
        if e.z_index < 0 {
            continue;
        }
        match best {
            Some(b) if b.z_index >= e.z_index => {}
            _ => best = Some(e),
        }
    }
    best
}

/// Generate the auto connections for `p` (ignores any existing auto
/// connections; user connections are consulted only to avoid a second
/// `replace` on the same target).
pub fn generate(p: &Project) -> Vec<Connection> {
    let mut out = Vec::new();
    let user_replaces: Vec<(&str, &str)> = p
        .connections
        .iter()
        .filter(|c| c.origin == Origin::User && c.combine == Combine::Replace)
        .map(|c| (c.element.as_str(), c.property.as_str()))
        .collect();

    let drums = p.stems.iter().find(|s| s.id == "drums");
    let mut assigned: Vec<&str> = Vec::new();

    if let Some(primary) = primary_element(p) {
        let pid = primary.id.as_str();

        // Rule 2: scale <- drum onset (else master onset)
        let src = match drums {
            Some(d) => {
                assigned.push(d.id.as_str());
                d.id.as_str()
            }
            None => MASTER_ID,
        };
        for prop in ["scaleX", "scaleY"] {
            out.push(conn(src, "onset", pid, prop, Curve::EaseOut, 0.0, 0.15, Combine::Add, 10.0, 200.0));
        }

        // Rule 3: positionX <- master low
        out.push(conn(MASTER_ID, "low", pid, "positionX", Curve::Smoothstep, -0.03, 0.03, Combine::Add, 100.0, 500.0));

        // Rule 6: melodic stems -> rotation
        for s in &p.stems {
            if is_melodic(s) && !assigned.contains(&s.id.as_str()) {
                out.push(conn(&s.id, "rms", pid, "rotation", Curve::Linear, -0.02, 0.02, Combine::Add, 200.0, 1000.0));
                assigned.push(s.id.as_str());
            }
        }

        // Rule 7: remaining stems -> hueShift
        for s in &p.stems {
            if !assigned.contains(&s.id.as_str()) {
                out.push(conn(&s.id, "rms", pid, "hueShift", Curve::Linear, 0.0, 20.0, Combine::Add, 100.0, 500.0));
            }
        }
    }

    // Rules 4 & 5: background elements (zIndex < 0)
    for e in p.elements.iter().filter(|e| e.z_index < 0) {
        if !user_replaces.contains(&(e.id.as_str(), "blur")) {
            out.push(conn(MASTER_ID, "low", &e.id, "blur", Curve::Linear, 0.0, AUTO_BLUR_MAX_PX, Combine::Replace, 100.0, 800.0));
        }
        out.push(conn(MASTER_ID, "rms", &e.id, "scale", Curve::Linear, 0.0, 0.03, Combine::Add, 50.0, 500.0));
    }

    out
}

/// Re-run: replace every `origin: auto` connection, keep `origin: user` ones.
pub fn apply(p: &mut Project) {
    p.connections.retain(|c| c.origin != Origin::Auto);
    let generated = generate(p);
    p.connections.extend(generated);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(stems: &[&str], elements: &[(&str, i32)]) -> Project {
        let stems_json: Vec<String> =
            stems.iter().map(|s| format!(r#"{{"id":"{s}","path":"{s}.wav","label":"{s}"}}"#)).collect();
        let els: Vec<String> = elements
            .iter()
            .map(|(id, z)| format!(r#"{{"id":"{id}","type":"static","path":"{id}.png","zIndex":{z}}}"#))
            .collect();
        serde_json::from_str(&format!(
            r#"{{"masterMix":{{"path":"m.wav"}},"stems":[{}],"elements":[{}]}}"#,
            stems_json.join(","),
            els.join(",")
        ))
        .unwrap()
    }

    #[test]
    fn primary_is_highest_nonnegative_first_on_tie() {
        let p = project(&[], &[("a", 0), ("b", 2), ("c", 2), ("bg", -1)]);
        assert_eq!(primary_element(&p).unwrap().id, "b");
    }

    #[test]
    fn drums_drive_scale_else_master() {
        let p = project(&["drums"], &[("hero", 1)]);
        let c = generate(&p);
        assert!(c.iter().any(|c| c.source == "drums" && c.feature == "onset" && c.property == "scaleX"));
        assert!(c.iter().any(|c| c.source == "drums" && c.property == "scaleY"));

        let p = project(&[], &[("hero", 1)]);
        let c = generate(&p);
        assert!(c.iter().any(|c| c.source == "master" && c.feature == "onset" && c.property == "scaleX"));
    }

    #[test]
    fn melodic_to_rotation_and_rest_to_hue() {
        let p = project(&["drums", "Violin", "pads"], &[("hero", 1)]);
        let c = generate(&p);
        assert!(c.iter().any(|c| c.source == "Violin" && c.property == "rotation"));
        assert!(c.iter().any(|c| c.source == "pads" && c.property == "hueShift"));
        assert!(!c.iter().any(|c| c.source == "drums" && c.property == "hueShift"));
        assert!(!c.iter().any(|c| c.source == "Violin" && c.property == "hueShift"));
    }

    #[test]
    fn background_gets_blur_replace_and_scale() {
        let p = project(&[], &[("hero", 1), ("bg", -1)]);
        let c = generate(&p);
        let blur = c.iter().find(|c| c.element == "bg" && c.property == "blur").unwrap();
        assert_eq!(blur.combine, Combine::Replace);
        let scale = c.iter().find(|c| c.element == "bg" && c.property == "scale").unwrap();
        assert_eq!(scale.feature, "rms");
    }

    #[test]
    fn never_targets_timing_and_output_validates() {
        let mut p = project(&["drums", "violin", "pads"], &[("hero", 1), ("bg", -1), ("mid", 0)]);
        apply(&mut p);
        for c in &p.connections {
            assert!(property_index(&c.property).is_some());
            assert!(!c.property.to_lowercase().contains("fps"));
            assert!(!c.property.to_lowercase().contains("frame"));
        }
        assert!(!has_errors(&validate(&p)));
    }

    #[test]
    fn rerun_replaces_auto_keeps_user() {
        let mut p = project(&["drums"], &[("hero", 1), ("bg", -1)]);
        let mut user = conn("master", "high", "hero", "opacity", Curve::Linear, 0.0, 0.1, Combine::Add, 0.0, 0.0);
        user.origin = Origin::User;
        p.connections.push(user);
        apply(&mut p);
        let n1 = p.connections.len();
        apply(&mut p);
        assert_eq!(p.connections.len(), n1);
        assert_eq!(p.connections.iter().filter(|c| c.origin == Origin::User).count(), 1);
    }

    #[test]
    fn user_replace_blur_is_not_duplicated() {
        let mut p = project(&[], &[("hero", 1), ("bg", -1)]);
        let mut user = conn("master", "mid", "bg", "blur", Curve::Linear, 0.0, 10.0, Combine::Replace, 0.0, 0.0);
        user.origin = Origin::User;
        p.connections.push(user);
        apply(&mut p);
        assert!(!has_errors(&validate(&p)));
    }

    #[test]
    fn no_primary_means_only_background_rules() {
        let p = project(&["drums"], &[("bg", -1)]);
        let c = generate(&p);
        assert!(c.iter().all(|c| c.element == "bg"));
    }
}
