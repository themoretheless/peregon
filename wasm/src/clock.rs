//! Monotonic millisecond clock for per-step timing.
//!
//! `std::time::Instant` compiles for `wasm32-unknown-unknown` but panics at
//! runtime, so the browser build binds `performance.now()` directly instead of
//! pulling in `js-sys`. Native builds (`cargo test`) keep using `Instant`.

#[cfg(target_arch = "wasm32")]
mod imp {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = performance, js_name = now)]
        fn performance_now() -> f64;
    }

    pub(super) fn now_ms() -> f64 {
        performance_now()
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use std::cell::OnceCell;
    use std::time::Instant;

    thread_local! {
        static ORIGIN: OnceCell<Instant> = const { OnceCell::new() };
    }

    pub(super) fn now_ms() -> f64 {
        ORIGIN.with(|origin| origin.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0)
    }
}

/// Milliseconds elapsed since an arbitrary fixed origin.
pub(crate) fn now_ms() -> f64 {
    imp::now_ms()
}

/// Milliseconds since `started`, clamped so a coarsened clock never reports
/// negative time. Browsers round `performance.now()` for privacy, so short
/// steps legitimately measure as `0.0`.
pub(crate) fn elapsed_ms(started: f64) -> f64 {
    (now_ms() - started).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_is_monotonic_and_never_negative() {
        let started = now_ms();
        let mut sink = 0u64;
        for index in 0..200_000u64 {
            sink = sink.wrapping_add(index);
        }
        assert!(sink > 0);
        assert!(elapsed_ms(started) >= 0.0);
        assert_eq!(elapsed_ms(now_ms() + 1_000.0), 0.0);
    }
}
